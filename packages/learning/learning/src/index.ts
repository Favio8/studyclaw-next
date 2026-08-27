/**
 * Rubric evaluator + quiz selection + dynamic cards + memory + gitops +
 * heatmap metrics. Ported from Python evaluator.py/quiz.py/cards.py/
 * memory.py/gitops.py/metrics.py (M4 scope).
 * @module @studyclaw/learning/src/index
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { harnessTask, type HarnessTask } from '@studyclaw/course-builder'
import { structuredCall, type StructuredCallClient } from '@studyclaw/course-builder'
import { EVALUATOR_SYSTEM, DYNAMIC_CARD_SYSTEM } from '@studyclaw/course-builder'
import { evaluatorUser } from '@studyclaw/course-builder'
import { dynamicCardUser } from '@studyclaw/course-builder'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { loadTaskPool } from '@studyclaw/course-builder'
import { loadProgressBoard, dueRecords } from '@studyclaw/course-builder'

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
}

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
      },
      this.options.maxRetries ?? 3,
    )
    const hits: Record<string, boolean> = {}
    rubric.forEach((criterion, index) => {
      hits[criterion] = verdict.judgements[index]?.hit ?? false
    })
    const passed = Object.values(hits).every(Boolean)
    return {
      taskId: task.task_id,
      conceptId: task.concept_id,
      score: passed ? 1 : Object.values(hits).filter(Boolean).length / Math.max(1, rubric.length),
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
 *  due-only queue used by the `review` command. */
export async function pickTasks(
  courseDir: string,
  mode: 'review' | 'new',
  conceptId: string | null,
  count: number,
  today = new Date().toISOString().slice(0, 10),
  dueOnly = false,
): Promise<HarnessTask[]> {
  const pool = (await loadTaskPool(courseDir)).filter(task => !task.deprecated)
  const board = await loadProgressBoard(join(courseDir, 'progress.md'))
  const due = new Set(dueRecords(board, today).map(record => record.conceptId))

  if (mode === 'review') {
    // 到期卡优先，最短尝试（attempts 升序）先出，未评测新卡在 due 不足时补位。
    const ordered = [...pool].sort((a, b) =>
      (a.history.attempts ?? 0) - (b.history.attempts ?? 0)
      || a.difficulty - b.difficulty
      || a.task_id.localeCompare(b.task_id),
    )
    // 概念聚焦：只看目标概念，忽略到期/补位语义（Python `_select` parity）。
    if (conceptId !== null) {
      return ordered.filter(task => task.concept_id === conceptId).slice(0, Math.max(1, count))
    }
    const picked = ordered.filter(task => due.has(task.concept_id)).slice(0, Math.max(1, count))
    if (!dueOnly) {
      const seen = new Set(picked.map(task => task.concept_id))
      for (const task of ordered) {
        if (picked.length >= Math.max(1, count)) break
        if ((task.history.attempts ?? 0) === 0 && !seen.has(task.concept_id)) {
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
  candidates.sort((a, b) => a.concept_id.localeCompare(b.concept_id) || a.difficulty - b.difficulty)
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
    evaluation_criteria: z.object({
      rubric: z.array(z.string()).min(2).max(4),
      keywords: z.array(z.string()).default([]),
      misattribution_options: z.array(z.string()).default([]),
    }),
  })).min(1),
})

export async function generateDynamicCards(
  client: StructuredCallClient,
  options: EvaluatorOptions,
  sourceTask: HarnessTask,
  misconception: string,
  count = 1,
  targetId: string | null = null,
): Promise<HarnessTask[]> {
  const batch = await structuredCall(
    client,
    dynamicBatch,
    {
      provider: options.provider,
      model: options.model,
      system: DYNAMIC_CARD_SYSTEM.replace('{misconception}', misconception),
      messages: [createUserMessage({ content: [{ type: 'text', text: dynamicCardUser(sourceTask.question, sourceTask.evaluation_criteria.rubric, misconception) }], source: { kind: 'user' } })],
    },
    options.maxRetries ?? 3,
  )
  return batch.tasks.slice(0, count).map((task, index) => ({
    ...task,
    task_id: `${sourceTask.concept_id.replace(/^c_/, '')}_dyn${Date.now()}${index}`,
    concept_id: sourceTask.concept_id,
    source_ref: sourceTask.source_ref,
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: true,
    target_id: targetId ?? `dynamic:${sourceTask.task_id}`,
  }))
}

// ---------------------------------------------------------------------------
// Memory (dual track, simplified promotion)
// ---------------------------------------------------------------------------

/** Read the workspace-level global profile (Memory.md). */
export async function readGlobalMemory(workspaceRoot: string): Promise<string> {
  return (await readFile(join(workspaceRoot, '.studyclaw', 'Memory.md'), 'utf8').catch(() => '')) ?? ''
}

/** Read the course memory pool evidence (sync audit lines). */
export async function readCourseMemoryPool(courseDir: string): Promise<string[]> {
  const historyDir = join(courseDir, 'history')
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

/** Best-effort `git add` + commit of the workspace (silently degrades). */
export async function autoCommit(workspaceRoot: string, courseName: string, changelog: string): Promise<void> {
  try {
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
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(ts)
  return match === null ? null : match[1]!
}

/** Aggregate chat/eval/weak-cleared per day over all course histories. */
export async function heatmap(workspaceRoot: string, weeks = 12): Promise<HeatmapPayload> {
  interface MutableDay { date: string; score: number; level: number; tasks: number; chatTurns: number; weakSpotsCleared: number }
  const days = new Map<string, MutableDay>()
  const lastFailed = new Map<string, boolean>()
  const ensure = (date: string): MutableDay => {
    const existing = days.get(date)
    if (existing !== undefined) return existing
    const fresh: MutableDay = { date, score: 0, level: 0, tasks: 0, chatTurns: 0, weakSpotsCleared: 0 }
    days.set(date, fresh)
    return fresh
  }
  // 项目即课程：会话历史直接位于项目根 history/。
  const historyDir = join(workspaceRoot, 'history')
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
        const date = rowDate(row)
        if (date === null) continue
        // 兼容 legacy 顶层行与 events 信封行：信封数据落在 row.payload 内。
        const payload = (typeof row['payload'] === 'object' && row['payload'] !== null) ? row['payload'] as Record<string, unknown> : {}
        if (row['type'] === 'chat' && row['role'] === 'user') ensure(date).chatTurns += 1
        const isEval = row['type'] === 'eval'
          || (typeof row['task_id'] === 'string' && row['misconceptions'] !== undefined)
          || (typeof payload['task_id'] === 'string' && payload['misconceptions'] !== undefined)
        if (isEval) {
          const day = ensure(date)
          day.tasks += 1
          const key = String(row['concept_id'] ?? payload['concept_id'] ?? '')
          const passed = Boolean(row['passed'] ?? payload['passed'])
          if (passed && lastFailed.get(key) === true) day.weakSpotsCleared += 1
          lastFailed.set(key, !passed)
        }
      }
    }
  }

  // Normalize scores, fill the window, and compute streaks.
  const start = new Date()
  start.setDate(start.getDate() - weeks * 7)
  const window: HeatmapDay[] = []
  for (let offset = weeks * 7 - 1; offset >= 0; offset -= 1) {
    const date = new Date()
    date.setDate(date.getDate() - offset)
    const key = date.toISOString().slice(0, 10)
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
  // 项目即课程：会话历史直接位于项目根 history/。
  const historyDir = join(workspaceRoot, 'history')
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
