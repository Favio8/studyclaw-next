/**
 * `studyclaw quiz` — review/new-mode question rounds with rubric evaluation:
 * pull tasks via `courses.quiz` (zero-leak quizView), prompt the user for an
 * answer, consume the six eval frames (scan/rubric×N/result/sm2/done from
 * `/api/eval.submit`), then render the verdict and a round summary. An empty
 * answer is locally short-circuited as 0%/FAILED without touching the server
 * (eval.submit rejects empty answers).
 * @module @studyclaw/cli/commands/quiz
 */

import { CliError, hostRpc, streamEval, type RpcFn, type SseFrame } from '../lib/client.ts'
import { EndOfInput, makeTerminal, type Terminal } from '../lib/terminal.ts'
import { parseArgs, UsageError } from '../lib/args.ts'
import { resolveCourse } from './course.ts'

export interface QuizTaskView {
  taskId: string
  conceptId: string
  type: string
  difficulty: number
  question: string
  options: string[] | null
}

export interface QuizOptions {
  courseId?: string | null
  conceptId?: string | null
  mode: 'new' | 'review'
  count: number
  headline?: string
  /** review 模式严格只出到期卡（review 命令语义），默认 false（到期优先+新卡补位）。 */
  dueOnly?: boolean
}

export interface QuizDeps {
  rpc: RpcFn
  evalStream: (payload: { courseId: string; taskId: string; answer: string; sessionId: string | null }) => AsyncIterable<SseFrame>
  terminal: Terminal
}

interface RoundResult {
  taskId: string
  conceptId: string
  score: number
  passed: boolean
  masteryDelta: number | null
  efNew: number | null
  nextReviewAt: string | null
}

const TYPE_LABELS: Record<string, string> = {
  concept: '概念题',
  practice: '练习',
  scenario: '场景',
  dynamic: '动态卡',
}

export async function runQuiz(deps: QuizDeps, options: QuizOptions): Promise<void> {
  const { terminal: t, rpc } = deps
  const course = await resolveCourse({ rpc, terminal: t }, options.courseId ?? null)
  const payload: Record<string, unknown> = {
    courseId: course.id,
    mode: options.mode,
    count: options.count,
  }
  if (options.conceptId !== null && options.conceptId !== undefined) payload.conceptId = options.conceptId
  if (options.dueOnly === true) payload.dueOnly = true
  const { tasks } = await rpc<{ tasks: QuizTaskView[] }>('courses.quiz', payload)

  if (tasks.length === 0) {
    // 空态分支与 Python CLI 一致：到期清空 vs 题卡池为空两个提示。
    if (options.mode === 'review') t.warn('今日到期队列已清空（可用 --mode new 解锁新题）')
    else t.warn('题卡池为空：请先运行 studyclaw sync 生成题卡')
    return
  }

  t.title(options.headline ?? 'QUIZ')
  const focus = options.conceptId !== null && options.conceptId !== undefined ? ` · 概念 ${options.conceptId}` : ''
  t.line(`${t.dim('课程')} ${course.title}（${course.id}） · ${t.dim('模式')} ${options.mode} · ${t.dim('题数')} ${tasks.length}${focus}`)
  t.blank()

  const rounds: RoundResult[] = []
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!
    t.hr()
    t.line(`Q${index + 1}/${tasks.length} · ${task.taskId} · ${TYPE_LABELS[task.type] ?? task.type} · ${t.stars(task.difficulty)}`)
    t.blank()
    t.line(task.question)
    if (task.options !== null && task.options.length > 0) {
      task.options.forEach((option, optionIndex) => {
        const letter = 'ABCDEFGH'[optionIndex] ?? `#${optionIndex + 1}`
        t.line(`  ${letter}. ${option}`)
      })
    }

    let answer: string
    try {
      answer = await t.prompt('> 作答: ')
    } catch (error) {
      if (error instanceof EndOfInput) throw new CliError('aborted', '已取消本轮（进度不变，可随时再来）')
      throw error
    }
    if (answer.trim() === '') {
      t.line(`${t.red('[MISS]')} 未作答：按 0 分 / × FAILED 处理（未触发评测，进度不变）`)
      rounds.push({ taskId: task.taskId, conceptId: task.conceptId, score: 0, passed: false, masteryDelta: null, efNew: null, nextReviewAt: null })
      continue
    }
    rounds.push(await evaluateRound(deps, course.id, task, answer))
  }

  t.blank()
  t.title('本轮结算')
  for (const round of rounds) {
    const verdict = round.passed ? t.green('√ PASSED') : t.red('× FAILED')
    const mastery = round.masteryDelta === null ? '·'.padStart(1) : fmtDelta(round.masteryDelta)
    const ef = round.efNew === null ? '-' : round.efNew.toFixed(2)
    const next = round.nextReviewAt === null ? '-' : round.nextReviewAt.slice(0, 10)
    t.line(`  ${round.taskId} · 得分 ${Math.round(round.score * 100)}% · ${verdict} · ${mastery} · EF ${ef} · 下次 ${next}`)
  }
  const passed = rounds.filter(round => round.passed).length
  t.blank()
  t.line(t.dim(`progress.md 已原子回写 · 通过 ${passed}/${rounds.length} · 评估轨迹已追加 history/*.jsonl`))
}

async function evaluateRound(deps: QuizDeps, courseId: string, task: QuizTaskView, answer: string): Promise<RoundResult> {
  const { terminal: t } = deps
  let score = 0
  let passed = false
  let feedback = ''
  const misconceptions: string[] = []
  let ef: number | null = null
  let efNew: number | null = null
  let nextReviewAt: string | null = null
  let masteryDelta: number | null = null

  t.blank()
  for await (const frame of deps.evalStream({ courseId, taskId: task.taskId, answer, sessionId: null })) {
    const data = frame.data as Record<string, unknown>
    switch (frame.event) {
      case 'scan':
        break
      case 'rubric': {
        const hit = data.hit === true
        t.line(`  ${hit ? t.green('[HIT]') : t.red('[MISS]')} ${String(data.criterion ?? '')}`)
        break
      }
      case 'result':
        score = Number(data.score ?? 0)
        passed = data.passed === true
        feedback = typeof data.feedback === 'string' ? data.feedback : ''
        if (Array.isArray(data.misconceptions)) misconceptions.push(...data.misconceptions.map(String))
        break
      case 'sm2':
        ef = data.ef === null || data.ef === undefined ? null : Number(data.ef)
        efNew = data.efNew === null || data.efNew === undefined ? null : Number(data.efNew)
        nextReviewAt = typeof data.nextReviewAt === 'string' ? data.nextReviewAt : null
        masteryDelta = data.masteryDelta === null || data.masteryDelta === undefined ? null : Number(data.masteryDelta)
        break
      case 'done':
        break
      case 'error':
        throw new CliError('EVAL_FAILED', `评测失败：${String(data.message ?? '未知错误')}`)
    }
  }

  t.line('')
  t.line(`${passed ? t.green('√ PASSED') : t.red('× FAILED')} · 得分 ${Math.round(score * 100)}%`)
  if (efNew !== null) {
    const efOld = ef !== null ? `${ef.toFixed(2)} → ` : ''
    const next = nextReviewAt === null ? '-' : nextReviewAt.slice(0, 10)
    t.line(t.dim(`掌握度 ${fmtDelta(masteryDelta ?? 0)} · EF ${efOld}${efNew.toFixed(2)} · 下次复习 ${next}`))
  }
  if (feedback !== '') t.line(`反馈：${feedback}`)
  for (const misconception of misconceptions) t.line(t.red(`误区：${misconception}`))

  return { taskId: task.taskId, conceptId: task.conceptId, score, passed, masteryDelta, efNew, nextReviewAt }
}

function fmtDelta(value: number): string {
  const pct = Math.round(value * 100)
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`
}

/** `studyclaw quiz [count] [--mode new|review] [--course <id>] [--concept <id>]` */
export async function quizCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const modeRaw = parsed.options.mode
  if (modeRaw !== undefined && (modeRaw === true || (modeRaw !== 'new' && modeRaw !== 'review'))) {
    throw new UsageError('--mode 取值 new | review')
  }
  const positionalCount = parsed.positionals[0]
  const count = positionalCount !== undefined ? parseInt(positionalCount, 10) : parseInt(String(parsed.options.count ?? '5'), 10)
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new UsageError('题数必须是 1..20 的整数')
  await runQuiz(makeQuizDeps(), {
    courseId: parsed.options.course === undefined ? null : String(parsed.options.course),
    conceptId: parsed.options.concept === undefined ? null : String(parsed.options.concept),
    mode: modeRaw === 'new' ? 'new' : 'review',
    count,
  })
}

export function makeQuizDeps(): QuizDeps {
  return {
    rpc: hostRpc,
    evalStream: payload => streamEval(payload),
    terminal: makeTerminal(),
  }
}
