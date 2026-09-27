/**
 * Rubric evaluator + quiz selection + dynamic cards + memory + gitops +
 * heatmap metrics. Ported from Python evaluator.py/quiz.py/cards.py/
 * memory.py/gitops.py/metrics.py (M4 scope).
 * @module @studyclaw/learning/src/index
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { harnessTask, type HarnessTask } from '@studyclaw/course-builder'
import { structuredCall, type StructuredCallClient } from '@studyclaw/course-builder'
import { EVALUATOR_SYSTEM, DYNAMIC_CARD_SYSTEM } from '@studyclaw/course-builder'
import { evaluatorUser } from '@studyclaw/course-builder'
import { dynamicCardUser } from '@studyclaw/course-builder'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'

import { loadTaskPool } from '@studyclaw/course-builder'
import { enforceTaskQuality } from '@studyclaw/course-builder'
import { loadProgressBoard, dueRecords } from '@studyclaw/course-builder'
import { localDateKey } from '@studyclaw/course-builder'

// ---------------------------------------------------------------------------
// Layout fallbacks (T-16)
// ---------------------------------------------------------------------------

/**
 * T-16：状态文件路径回退——v2 布局（`<root>/.studyclaw/<name>`）优先，旧布局
 * 根目录兜底。与 tools 的 resolveStateFile 同口径：硬编码 `.studyclaw/` 会让
 * 未迁移旧布局的工作区"静默失效"（进度板读不到 → 到期调度恒空；history 读不到
 * → 热力图恒 0），且无任何告警。
 */
async function stateFilePath(root: string, name: string): Promise<string> {
  const v2 = join(root, '.studyclaw', name)
  if ((await stat(v2).catch(() => null))?.isFile()) return v2
  return join(root, name)
}

/** T-16：会话历史目录回退（v2 `<root>/.studyclaw/history`，旧布局 `<root>/history`）。 */
async function historyDirOf(root: string): Promise<string> {
  const v2 = join(root, '.studyclaw', 'history')
  if ((await stat(v2).catch(() => null))?.isDirectory()) return v2
  const legacy = join(root, 'history')
  if ((await stat(legacy).catch(() => null))?.isDirectory()) return legacy
  return v2
}

// ---------------------------------------------------------------------------
// Evaluator (rubric binary hit)
// ---------------------------------------------------------------------------

const judgeVerdict = z.object({
  judgements: z.array(z.object({ criterion: z.string(), hit: z.boolean() })),
  feedback: z.string(),
  misconceptions: z.array(z.string()).default([]),
  misattribution: z.enum(['概念混淆', '推导漏洞', '边界遗漏', '无']).default('无'),
})

export interface EvaluationResult {
  readonly taskId: string
  readonly conceptId: string
  readonly score: number
  readonly passed: boolean
  readonly rubricHits: Record<string, boolean>
  readonly feedback: string
  readonly misconceptions: string[]
  readonly suggestedReviewDays: number | null
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationError'
  }
}

export interface EvaluatorOptions {
  maxRetries?: number
  model: string
  provider: string
  temperature?: number
  /** 判题提速（A 档）：'off' 直接映射 thinking:disabled，砍掉思维链等待。 */
  reasoningEffort?: GenerateOptions['reasoningEffort']
  /** 判题输出只有几百 token 的 JSON，缺省继承适配器大预算纯属浪费。 */
  maxTokens?: number
}

/**
 * FL-26：唯一的"通过"阈值。必须与 `scoreToQuality`（progress.ts:229-235）的
 * q≥3 分界（score ≥ 0.6）保持一致——SM-2 用 q 决定间隔/EF 走向，streak 与
 * mastery 用 `passed` 决定，两者若不一致就会出现"EF 说过了、streak 说重来"。
 */
const PASS_SCORE = 0.6

/** Rubric binary-hit evaluator over the dsh-adapter stream client. */
export class RubricEvaluator {
  constructor(
    private readonly client: StructuredCallClient,
    private readonly options: EvaluatorOptions,
  ) {}

  async evaluate(task: HarnessTask, studentAnswer: string, userMemory = ''): Promise<EvaluationResult> {
    const rubric = task.evaluation_criteria.rubric
    if (studentAnswer.trim() === '') {
      return {
        taskId: task.task_id, conceptId: task.concept_id, score: 0, passed: false,
        rubricHits: Object.fromEntries(rubric.map(criterion => [criterion, false])),
        feedback: '请先写下你的作答，再来判定。', misconceptions: [], suggestedReviewDays: 1,
      }
    }
    const verdict = await structuredCall(
      this.client,
      judgeVerdict,
      {
        provider: this.options.provider,
        model: this.options.model,
        system: EVALUATOR_SYSTEM,
        messages: [createUserMessage({ content: [{ type: 'text', text: evaluatorUser(task.question, rubric, studentAnswer, userMemory) }], source: { kind: 'user' } })],
        ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
        ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
        ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      },
      this.options.maxRetries ?? 3,
    )
    // F-15：按 criterion 文本对齐判定结果，而不是数组下标——LLM 调换顺序
    // 或漏条时，下标法会把命中记到错误的采分点上。未匹配的采分点按"未命中"
    // 计并在日志中显式暴露，宁可错杀不可错记。
    const normalizeCriterion = (value: string): string => value.replace(/\s+/g, '').toLowerCase()
    const hitByCriterion = new Map<string, boolean>()
    for (const judgement of verdict.judgements) {
      const key = normalizeCriterion(judgement.criterion)
      if (!hitByCriterion.has(key)) hitByCriterion.set(key, judgement.hit)
    }
    const hits: Record<string, boolean> = {}
    let aligned = 0
    rubric.forEach(criterion => {
      const hit = hitByCriterion.get(normalizeCriterion(criterion))
      if (hit !== undefined) aligned += 1
      hits[criterion] = hit ?? false
    })
    if (aligned < rubric.length) {
      console.warn(`[evaluator] LLM 判定与评分点仅对齐 ${aligned}/${rubric.length} 条；缺失项按未命中计`)
    }
    // FL-26：旧实现 `passed` 是"全部采分点命中"（全有全无），而 SM-2 消费的是
    // 比例分 `score`（经 `scoreToQuality` 的 0.6 阈值转 q）。两套口径打架：
    // 命中 3/4 时 passed=false，但 q=3 走 SM-2 的通过分支——EF 按 q=3 微调，
    // streak 却被清零，两个字段互相矛盾（首次命中 75% 还会算出 mastery=0）。
    // 统一为：以 score ≥ 0.6 作为唯一的 passed 定义，与 q≥3 严格对齐。
    const hitCount = Object.values(hits).filter(Boolean).length
    const score = hitCount / Math.max(1, rubric.length)
    const passed = score >= PASS_SCORE
    return {
      taskId: task.task_id,
      conceptId: task.concept_id,
      score,
      passed,
      rubricHits: hits,
      feedback: verdict.feedback,
      misconceptions: verdict.misconceptions,
      suggestedReviewDays: passed ? null : 1,
    }
  }
}

// ---------------------------------------------------------------------------
// Quiz selection
// ---------------------------------------------------------------------------

/** Pick review/new tasks (Python `_select` parity): due-first with unjudged
 *  (attempts=0) card fill for the review mode; `dueOnly` pins the strict
 *  due-only queue used by the `review` command.
 *  T-4：同排序键（attempts/difficulty）内随机洗牌——旧实现完全确定性，
 *  同一概念每次出同一张卡，学生可记忆题面与答案位。rng 可注入（测试用
 *  常量函数即恢复确定性），默认 Math.random。 */
export async function pickTasks(
  courseDir: string,
  mode: 'review' | 'new',
  conceptId: string | null,
  count: number,
  today: string = localDateKey(),
  dueOnly = false,
  rng: () => number = Math.random,
): Promise<HarnessTask[]> {
  const pool = (await loadTaskPool(courseDir)).filter(task => !task.deprecated)
  // T-16：进度板路径回退（v2 布局优先、旧布局根目录兜底）——硬编码
  // `.studyclaw/` 让未迁移的旧布局工作区到期调度静默失效（板读不到 → 无到期）。
  const board = await loadProgressBoard(await stateFilePath(courseDir, 'progress.md'))
  const due = new Set(dueRecords(board, today).map(record => record.conceptId))

  // FL-24：学习进度的权威在 `progress.md`——`evalSubmit` 只写它，从不回写 task
  // pool（见 course.ts:505-532，`writeTaskPool` 的调用点全在构建/去重/动态卡）。
  // 因此 `task.history.attempts` 恒为生成时的 0（task-gen.ts:82），用它排序会让
  // "最短尝试先出"退化成按 id 排序，用它判"是否新卡"则把所有练过的卡都当新卡补位。
  // 这里改为从进度板读取真实评测次数。
  const evalsByConcept = new Map(board.concepts.map(record => [record.conceptId, record.evals]))
  const attemptsOf = (task: HarnessTask): number => evalsByConcept.get(task.concept_id) ?? 0

  if (mode === 'review') {
    // 到期卡优先，最短尝试（attempts 升序）先出，未评测新卡在 due 不足时补位。
    // T-4：同 (attempts, difficulty) 内以随机键打乱（确定性主序不变）。
    const jitter = new Map(pool.map(task => [task, rng()] as const))
    const ordered = [...pool].sort((a, b) =>
      attemptsOf(a) - attemptsOf(b)
      || a.difficulty - b.difficulty
      || jitter.get(a)! - jitter.get(b)!,
    )
    // 概念聚焦：只看目标概念，忽略到期/补位语义（Python `_select` parity）。
    if (conceptId !== null) {
      return ordered.filter(task => task.concept_id === conceptId).slice(0, Math.max(1, count))
    }
    // T-4：到期挑选按概念去重——旧实现直接 slice，count 内可能全是同一概念
    // 的多张卡（学生可记忆题面与答案位，公平性缺陷）；不足 count 时再用同概念
    // 的其余到期卡补位（不少题）。
    const limit = Math.max(1, count)
    const picked: HarnessTask[] = []
    const seenConcepts = new Set<string>()
    for (const task of ordered) {
      if (picked.length >= limit) break
      if (!due.has(task.concept_id) || seenConcepts.has(task.concept_id)) continue
      seenConcepts.add(task.concept_id)
      picked.push(task)
    }
    for (const task of ordered) {
      if (picked.length >= limit) break
      if (!due.has(task.concept_id) || picked.includes(task)) continue
      picked.push(task)
    }
    if (!dueOnly) {
      const seen = new Set(picked.map(task => task.concept_id))
      for (const task of ordered) {
        if (picked.length >= limit) break
        if (attemptsOf(task) === 0 && !seen.has(task.concept_id)) {
          picked.push(task)
          seen.add(task.concept_id)
        }
      }
    }
    return picked
  }

  let candidates = pool.filter(task => !due.has(task.concept_id))
  if (conceptId !== null) candidates = candidates.filter(task => task.concept_id === conceptId)
  // Stability: sort by concept then difficulty so picks are reproducible.
  // T-4：同 (concept, difficulty) 内随机（rng 可注入恢复确定性）。
  const jitter = new Map(candidates.map(task => [task, rng()] as const))
  candidates.sort((a, b) => a.concept_id.localeCompare(b.concept_id) || a.difficulty - b.difficulty
    || jitter.get(a)! - jitter.get(b)!)
  return candidates.slice(0, Math.max(1, count))
}

/** Public quiz view: no rubric, no answers (zero leak). */
export function quizView(task: HarnessTask): Record<string, unknown> {
  return {
    taskId: task.task_id,
    conceptId: task.concept_id,
    type: task.type,
    difficulty: task.difficulty,
    question: task.question,
    options: task.options,
    // MCQ 答案键：UI 答后高亮正确项与即时判分用。本地单用户应用，
    // 下发到浏览器内存不构成泄题面（服务端 rubric/keywords 仍不下发）。
    answerIndex: task.answer_index ?? null,
    answerRationale: task.answer_rationale ?? null,
  }
}

// ---------------------------------------------------------------------------
// Dynamic cards (F5)
// ---------------------------------------------------------------------------

const dynamicBatch = z.object({
  tasks: z.array(z.object({
    type: z.enum(['concept', 'scenario', 'debug_edge']),
    difficulty: z.number().int().min(1).max(5),
    question: z.string(),
    options: z.array(z.string()).nullable().default(null),
    answer_index: z.number().int().min(0).nullable().default(null),
    answer_rationale: z.string().nullable().default(null),
    evaluation_criteria: z.object({
      rubric: z.array(z.string()).min(2).max(4),
      keywords: z.array(z.string()).default([]),
      misattribution_options: z.array(z.string()).default([]),
    }),
    // T-5：对齐 builder models.ts 的 generatedTask 校验——此前动态卡完全绕过
    // 该 superRefine，越界/缺失 answer_index 的选择题入池后 MCQ 快判
    // `options[i] ?? ''` 恒不匹配，该卡永无法通过（静默坏卡）。
  }).superRefine((task, ctx) => {
    if (Array.isArray(task.options) && task.options.length > 0) {
      if (task.answer_index === null || task.answer_index >= task.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `选择题必须给出 answer_index（0~${task.options.length - 1}）`,
          path: ['answer_index'],
        })
      }
    }
  })).min(1),
})

export async function generateDynamicCards(
  client: StructuredCallClient,
  options: EvaluatorOptions,
  sourceTask: HarnessTask,
  misconception: string,
  count = 1,
  targetId: string | null = null,
  // T-6：取消信号缝——GenerateOptions 原生支持 signal，透传给 client.stream
  // 后适配器可中止在途 LLM 流。工具边界的完整穿线（ToolActionContext →
  // CourseService → 生成器）属后续重构，此处先把缝留好。
  signal?: AbortSignal,
): Promise<HarnessTask[]> {
  const batch = await structuredCall(
    client,
    dynamicBatch,
    {
      provider: options.provider,
      model: options.model,
      system: DYNAMIC_CARD_SYSTEM.replace('{misconception}', misconception),
      messages: [createUserMessage({ content: [{ type: 'text', text: dynamicCardUser(sourceTask.question, sourceTask.evaluation_criteria.rubric, misconception) }], source: { kind: 'user' } })],
      ...(signal === undefined ? {} : { signal }),
    },
    options.maxRetries ?? 3,
  )
  const candidates = batch.tasks.slice(0, count).map((task, index) => ({
    ...task,
    // T-19：`_dyn${Date.now()}${index}` 在同毫秒跨批会碰撞（mock/高速连续）
    // → 池内 id 重复。加随机后缀；target_id 仍指向源题，不影响溯源。
    task_id: `${sourceTask.concept_id.replace(/^c_/, '')}_dyn${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 6)}`,
    concept_id: sourceTask.concept_id,
    source_ref: sourceTask.source_ref,
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: true,
    target_id: targetId ?? `dynamic:${sourceTask.task_id}`,
  }))
  // T-5：动态卡与生成批同一道质量闸——此前动态卡完全不过闸，越界答案键 /
  // 选项长度失衡的坏卡直接入池（永无法通过或正确项可被猜中）。闸掉的卡不进池，
  // 由调用方按数量缺口决定是否重试。
  return enforceTaskQuality(candidates).kept
}

// ---------------------------------------------------------------------------
// Memory (dual track, simplified promotion)
// ---------------------------------------------------------------------------

/** Read the workspace-level global profile (Memory.md). */
export async function readGlobalMemory(workspaceRoot: string): Promise<string> {
  // T-16：v2 优先、旧布局根目录兜底。
  return (await readFile(await stateFilePath(workspaceRoot, 'Memory.md'), 'utf8').catch(() => '')) ?? ''
}

/** Read the course memory pool evidence (sync audit lines). */
export async function readCourseMemoryPool(courseDir: string): Promise<string[]> {
  // P1-7：与写入侧一致——历史目录在 <课程根>/.studyclaw/history。
  // T-16：旧布局（根目录 history/）回退。
  const historyDir = await historyDirOf(courseDir)
  const hints: string[] = []
  if (!(await (await import('node:fs/promises')).stat(historyDir).catch(() => null))?.isDirectory()) return hints
  for (const name of (await readdir(historyDir)).filter(name => name.endsWith('.jsonl'))) {
    const text = await readFile(join(historyDir, name), 'utf8').catch(() => '')
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('"memory_pool"')) {
        try {
          const row = JSON.parse(line) as { summary?: string }
          if (typeof row.summary === 'string' && row.summary.startsWith('hints: ')) {
            hints.push(...row.summary.slice(7).split('；').filter(hint => hint !== ''))
          }
        } catch {
          // Corrupt row skipped.
        }
      }
    }
  }
  return hints
}

// ---------------------------------------------------------------------------
// Gitops (silent auto-commit, never blocks the session)
// ---------------------------------------------------------------------------

/**
 * T-18：题池（含答案键）与评测幂等账本不进用户的 git 历史——gitops 的
 * `git add -A` 会把 .studyclaw 全量提交，答案/评分痕迹随之进入仓库历史且
 * 无法真正"取消"。在状态目录落一份 .gitignore（幂等、best-effort）：只排除
 * 答案-bearing 文件，进度/大纲/会话历史仍按 gitops 设计照常提交。
 * 注意：已被历史提交跟踪的文件不会被 .gitignore 自动 untrack（需用户自行
 * `git rm --cached`），此处只防止未来的提交。
 */
async function ensureStateGitignore(workspaceRoot: string): Promise<void> {
  const stateDir = join(workspaceRoot, '.studyclaw')
  const gitignore = join(stateDir, '.gitignore')
  const existing = await readFile(gitignore, 'utf8').catch(() => null)
  if (existing !== null && existing.includes('tasks/')) return
  await mkdir(stateDir, { recursive: true })
  await writeFile(gitignore, ['# studyclaw: 答案-bearing 状态文件不进 git 历史', 'tasks/', 'eval-ledger/', ''].join('\n'), 'utf8').catch(() => undefined)
}

/** Best-effort `git add` + commit of the workspace (silently degrades). */
export async function autoCommit(workspaceRoot: string, courseName: string, changelog: string): Promise<void> {
  try {
    // T-18：先保证答案-bearing 文件被 .gitignore 排除，再 add -A。
    await ensureStateGitignore(workspaceRoot)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    await exec('git', ['-C', workspaceRoot, 'add', '-A'], { timeout: 30_000 })
    await exec('git', ['-C', workspaceRoot, 'commit', '-m', `📚 studyclaw: ${courseName} — ${changelog}`], { timeout: 30_000 })
  } catch {
    // Not a git repo / no changes / git unavailable: silent by contract.
  }
}

// ---------------------------------------------------------------------------
// Heatmap metrics (history jsonl aggregation)
// ---------------------------------------------------------------------------

export interface HeatmapDay {
  readonly date: string
  readonly score: number
  readonly level: 0 | 1 | 2 | 3
  readonly tasks: number
  readonly chatTurns: number
  readonly weakSpotsCleared: number
}

export interface HeatmapPayload {
  readonly weeks: number
  readonly days: HeatmapDay[]
  readonly streak: { current: number; best: number }
}

function levelOf(score: number): 0 | 1 | 2 | 3 {
  if (score <= 0) return 0
  if (score <= 3) return 1
  if (score <= 7) return 2
  return 3
}

function rowDate(row: Record<string, unknown>): string | null {
  const ts = row['ts']
  if (typeof ts !== 'string') return null
  // F-13：时间戳按本地时区归日（ISO 时间戳是 UTC，直接截日期会错桶）。
  const parsed = new Date(ts)
  if (Number.isNaN(parsed.getTime())) return null
  return localDateKey(parsed)
}

/** Aggregate chat/eval/weak-cleared per day over all course histories. */
export async function heatmap(workspaceRoot: string, weeks = 12): Promise<HeatmapPayload> {
  interface MutableDay { date: string; score: number; level: number; tasks: number; chatTurns: number; weakSpotsCleared: number }
  const days = new Map<string, MutableDay>()
  const ensure = (date: string): MutableDay => {
    const existing = days.get(date)
    if (existing !== undefined) return existing
    const fresh: MutableDay = { date, score: 0, level: 0, tasks: 0, chatTurns: 0, weakSpotsCleared: 0 }
    days.set(date, fresh)
    return fresh
  }
  // 项目即课程：会话历史位于项目根 .studyclaw/history（P1-7 双轨制修复）。
  // T-16：旧布局（根目录 history/）回退——硬编码让未迁移工作区热力图恒 0。
  const historyDir = await historyDirOf(workspaceRoot)
  const chatTurnsByDate = new Map<string, number>()
  const evalRecords: Array<{ ts: string; date: string; key: string; passed: boolean }> = []
  if ((await (await import('node:fs/promises')).stat(historyDir).catch(() => null))?.isDirectory()) {
    for (const name of (await readdir(historyDir)).filter(name => name.endsWith('.jsonl'))) {
      const text = await readFile(join(historyDir, name), 'utf8').catch(() => '')
      const rows: Array<Record<string, unknown>> = []
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          continue
        }
      }
      // H3：事件日志口径的输入剔除标记先行收集，被 void 的输入不计聊天轮。
      const voidedSeqs = new Set<number>()
      for (const row of rows) {
        if (row['type'] !== 'input/voided') continue
        const payload = (typeof row['payload'] === 'object' && row['payload'] !== null) ? row['payload'] as Record<string, unknown> : {}
        const seq = Number(payload['seq'] ?? 0)
        if (Number.isInteger(seq) && seq > 0) voidedSeqs.add(seq)
      }
      for (const row of rows) {
        const date = rowDate(row)
        if (date === null) continue
        // 兼容 legacy 顶层行与 events 信封行：信封数据落在 row.payload 内。
        const payload = (typeof row['payload'] === 'object' && row['payload'] !== null) ? row['payload'] as Record<string, unknown> : {}
        const type = String(row['type'] ?? '')
        // H3：legacy `chat` 行与事件日志 `user/input` 行都计聊天轮。
        const isUserChat = (type === 'chat' && row['role'] === 'user')
          || (type === 'user/input' && !voidedSeqs.has(Number(row['seq'] ?? 0)))
        if (isUserChat) chatTurnsByDate.set(date, (chatTurnsByDate.get(date) ?? 0) + 1)
        const isEval = type === 'eval'
          || (typeof row['task_id'] === 'string' && row['misconceptions'] !== undefined)
          || (typeof payload['task_id'] === 'string' && payload['misconceptions'] !== undefined)
        if (isEval) {
          evalRecords.push({
            ts: typeof row['ts'] === 'string' ? row['ts'] : '',
            date,
            key: String(row['concept_id'] ?? payload['concept_id'] ?? ''),
            passed: Boolean(row['passed'] ?? payload['passed']),
          })
        }
      }
    }
  }
  for (const [date, count] of chatTurnsByDate) ensure(date).chatTurns += count
  // L8：跨文件按时间序折叠 lastFailed——readdir 字典序在 fork/迁移场景会把
  // 「先错后对」误判成「先对后错」，weakSpotsCleared 因此依赖文件迭代顺序。
  evalRecords.sort((a, b) => a.ts.localeCompare(b.ts))
  const lastFailed = new Map<string, boolean>()
  for (const record of evalRecords) {
    const day = ensure(record.date)
    day.tasks += 1
    if (record.passed && lastFailed.get(record.key) === true) day.weakSpotsCleared += 1
    lastFailed.set(record.key, !record.passed)
  }

  // Normalize scores, fill the window, and compute streaks.
  const window: HeatmapDay[] = []
  for (let offset = weeks * 7 - 1; offset >= 0; offset -= 1) {
    const date = new Date()
    date.setDate(date.getDate() - offset)
    const key = localDateKey(date)
    const day = days.get(key) ?? { date: key, score: 0, level: 0, tasks: 0, chatTurns: 0, weakSpotsCleared: 0 }
    const score = day.chatTurns + day.tasks * 2 + day.weakSpotsCleared * 3
    window.push({ ...day, score, level: levelOf(score) })
  }
  let current = 0
  let best = 0
  let running = 0
  for (const day of window) {
    if (day.score > 0) {
      running += 1
      best = Math.max(best, running)
    } else {
      running = 0
    }
  }
  // Current streak counts backward from today.
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (window[i]!.score > 0) current += 1
    else break
  }
  return { weeks, days: window, streak: { current, best } }
}

export interface HeatmapDayDetail {
  readonly date: string
  readonly changelog: string[]
  readonly events: Array<{ ts: string | null; type: string; taskId: string | null; passed: boolean }>
}

/** One day's event log over all course histories. */
export async function heatmapDay(workspaceRoot: string, date: string): Promise<HeatmapDayDetail> {
  const changelog: string[] = []
  const events: HeatmapDayDetail['events'] = []
  // 项目即课程：会话历史位于项目根 .studyclaw/history（P1-7 双轨制修复）。
  // T-16：旧布局（根目录 history/）回退。
  const historyDir = await historyDirOf(workspaceRoot)
  if ((await (await import('node:fs/promises')).stat(historyDir).catch(() => null))?.isDirectory()) {
    for (const name of (await readdir(historyDir)).filter(name => name.endsWith('.jsonl'))) {
      const text = await readFile(join(historyDir, name), 'utf8').catch(() => '')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (rowDate(row) !== date) continue
        // 兼容 legacy 顶层行与 events 信封行：信封数据落在 row.payload 内。
        const payload = (typeof row['payload'] === 'object' && row['payload'] !== null) ? row['payload'] as Record<string, unknown> : {}
        if (row['type'] === 'sync' && row['target'] === 'progress.md') {
          changelog.push(String(row['summary'] ?? ''))
        }
        // H3：事件日志口径的掌握度同步也进 changelog（sync/applied 的 payload
        // 是同步块本体，审计行只存在于 legacy 存储）。
        if (row['type'] === 'sync/applied' && Array.isArray(payload['concept_updates'])) {
          const ids = (payload['concept_updates'] as Array<unknown>)
            .map(item => typeof item === 'object' && item !== null ? String((item as Record<string, unknown>)['id'] ?? '') : '')
            .filter(id => id !== '')
          if (ids.length > 0) changelog.push(`同步掌握度：${ids.join('、')}`)
        }
        const isEval = row['type'] === 'eval'
          || (typeof row['task_id'] === 'string' && row['misconceptions'] !== undefined)
          || (typeof payload['task_id'] === 'string' && payload['misconceptions'] !== undefined)
        if (isEval) {
          events.push({
            ts: typeof row['ts'] === 'string' ? row['ts'] : null,
            type: String(row['type'] ?? 'eval'),
            taskId: typeof row['task_id'] === 'string' ? row['task_id'] : (typeof payload['task_id'] === 'string' ? payload['task_id'] : null),
            passed: Boolean(row['passed'] ?? payload['passed']),
          })
        }
      }
    }
  }
  events.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))
  return { date, changelog, events }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { harnessTask }
export type { ProgressBoard, ProgressRecord } from '@studyclaw/course-builder'
