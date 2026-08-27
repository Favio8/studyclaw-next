/**
 * 题卡生成后质量闸（题卡质量 A 档）：纯规则、零 LLM 成本。
 * 在生成与入库之间执行——不合格的卡进 build report 的 degraded，不进题池。
 * 规则来自对真实题池的体检结论：
 * - 正确项恒最长（承载全部限定词，干扰项 30~60 字）→ 长度失衡卡直接丢弃；
 * - MCQ 缺/越界 answer_index → 无法客观判分，丢弃；
 * - 同概念内题干近似重复 → 丢弃后到者。
 * @module @studyclaw/course-builder/src/quality
 */

import type { HarnessTask } from './models.ts'

export interface QualityGateResult {
  kept: HarnessTask[]
  dropped: Array<{ taskId: string; reason: string }>
  /** 答案位置分布（仅 MCQ）：key=位置，value=张数。供分布偏斜告警。 */
  answerPositionHistogram: Record<number, number>
}

/** 归一化题干：去空白/标点差异后的小写形式，用于近似重复判定。 */
function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[\s，。；：、！？"'"（）()【】\[\]—\-·…]/g, '')
}

/** 单卡规则检查：返回 null 表示合格，否则给出丢弃原因。
 *  seen：同概念 + 同源文件的已收录题干（跨文件的同概念题允许同题干——
 *  不同切片合并到同一概念是合法场景，如 id 冲突重排用例）。 */
export function checkTaskQuality(task: HarnessTask, seenQuestions: string[]): string | null {
  const options = task.options
  if (Array.isArray(options) && options.length > 0) {
    if (task.answer_index === null || task.answer_index === undefined) {
      return '选择题缺少 answer_index（无法客观判分）'
    }
    if (task.answer_index < 0 || task.answer_index >= options.length) {
      return `answer_index ${task.answer_index} 越界（选项数 ${options.length}）`
    }
    const lens = options.map(option => option.length)
    const shortest = Math.min(...lens)
    const longest = Math.max(...lens)
    if (shortest > 0 && longest / shortest > 2.5) {
      return `选项长度失衡（最长 ${longest} 字 / 最短 ${shortest} 字，正确项可被猜中）`
    }
  }
  const normalized = normalizeQuestion(task.question)
  for (const seen of seenQuestions) {
    // 只判归一化后完全一致：长公共前缀会让相似度阈值误杀「问题 1 / 问题 2」
    // 这类仅差末位序号的合法系列题（实测相似度高达 0.91），而 LLM 重复输出
    // 的典型形态恰是逐字回声。
    if (normalized === seen) {
      return '与同概念已有题卡题干完全一致（疑似重复）'
    }
  }
  return null
}

/** 对一批新卡执行质量闸：按序保留合格卡、记录丢弃原因与答案位置分布。 */
export function enforceTaskQuality(tasks: readonly HarnessTask[]): QualityGateResult {
  const kept: HarnessTask[] = []
  const dropped: QualityGateResult['dropped'] = []
  const seenByScope = new Map<string, string[]>()
  const answerPositionHistogram: Record<number, number> = {}
  for (const task of tasks) {
    const scope = `${task.concept_id}|${task.source_ref?.file ?? ''}`
    const reason = checkTaskQuality(task, seenByScope.get(scope) ?? [])
    if (reason !== null) {
      dropped.push({ taskId: task.task_id, reason })
      continue
    }
    const scopeSeen = seenByScope.get(scope) ?? []
    scopeSeen.push(normalizeQuestion(task.question))
    seenByScope.set(scope, scopeSeen)
    if (Array.isArray(task.options) && task.options.length > 0 && task.answer_index !== null && task.answer_index !== undefined) {
      answerPositionHistogram[task.answer_index] = (answerPositionHistogram[task.answer_index] ?? 0) + 1
    }
    kept.push(task)
  }
  return { kept, dropped, answerPositionHistogram }
}

/** 答案位置偏斜告警：单一位置占比超阈值时提示（不丢弃，仅提示出题方）。 */
export function answerPositionSkewWarning(histogram: Record<number, number>): string | null {
  const total = Object.values(histogram).reduce((sum, count) => sum + count, 0)
  if (total < 4) return null
  const [position, count] = Object.entries(histogram).reduce((max, entry) => (entry[1] > max[1] ? entry : max))
  if (count / total > 0.6) {
    return `answer_index=${position} 的题卡占 ${count}/${total}——正确项位置偏斜，建议检查 prompt 轮换是否生效`
  }
  return null
}
