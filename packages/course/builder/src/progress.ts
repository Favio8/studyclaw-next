/**
 * Progress board: the 9-column markdown contract (`progress.md`) — meta
 * lines, fixed column set with emoji mastery cells, parse/render round-trip,
 * atomic save, due records, and SM-2 scheduling. Ported from Python
 * `progress.py` + `scheduler.py`.
 * @module @studyclaw/learning/src/progress
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'

export interface ProgressRecord {
  readonly conceptId: string
  readonly name: string
  readonly chapter: string
  readonly mastery: number
  readonly evals: number
  readonly passRate: number
  /** 连续答对次数（F-12：SM-2 的 repetitions 输入；失败清零）。 */
  readonly streak: number
  readonly ef: number
  readonly nextReviewAt: string | null
  readonly misattribution: string
}

/** Mutable variant for when `name`/`chapter` must be refreshed from the latest syllabus. */
export type ProgressRecordMutable = { -readonly [K in keyof ProgressRecord]: ProgressRecord[K] }

export interface ProgressBoard {
  readonly overallMastery: number
  readonly dueCount: number
  readonly lastUpdatedAt: string | null
  readonly concepts: ProgressRecord[]
}

export const COLUMNS = ['concept_id', 'name', 'chapter', 'mastery', 'evals', 'pass_rate', 'ef', 'next_review_at', 'misattribution', 'streak'] as const
const NO_DATE = '-'
const MASTERY_CELL_RE = /[🟢🟡🔴]?\s*(\d+(?:\.\d+)?)\s*%/
const MASTERY_RE = /-\s*\*\*总体掌握度\*\*[:：]\s*([\d.]+)%/
const DUE_RE = /-\s*\*\*待复习卡片数\*\*[:：]\s*(\d+)/
const UPDATED_RE = /-\s*\*\*最后更新时间\*\*[:：]\s*([\d\- :]+)/

/**
 * F-13：本地时区的 YYYY-MM-DD。到期/今日/热力图分桶统一用它——
 * `toISOString()` 是 UTC，UTC+8 的用户在 00:00–07:59 会整体错一天，
 * 而早晨正是复习高发时段。
 */
export function localDateKey(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new RangeError('无效日期')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function renderMastery(mastery: number): string {
  const emoji = mastery >= 0.7 ? '🟢' : mastery >= 0.4 ? '🟡' : '🔴'
  return `${emoji} ${Math.round(mastery * 100)}%`
}

function parseMasteryCell(cell: string): number {
  const match = MASTERY_CELL_RE.exec(cell)
  if (match === null) return 0
  return Math.min(1, Number(match[1]) / 100)
}

/** F-11：单元格写入前转义 `|`、反斜杠与换行——章节标题来自用户讲义，
 * 未转义会让一行坏表把解析截断、其后所有概念的掌握度历史静默丢失。 */
function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*[\r\n]+\s*/g, ' ')
}

/** 与 escapeCell 对应的拆分器：按未转义的 `|` 切分，转义序列还原为字面值。 */
function splitTableCells(row: string): string[] {
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const ch of row) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}

function renderRecordRow(record: ProgressRecord): string {
  const cells = [
    `\`${escapeCell(record.conceptId)}\``,
    escapeCell(record.name),
    escapeCell(record.chapter),
    renderMastery(record.mastery),
    String(record.evals),
    `${Math.round(record.passRate * 100)}%`,
    record.ef.toFixed(2),
    record.nextReviewAt !== null ? record.nextReviewAt.slice(0, 10) : NO_DATE,
    record.misattribution,
    String(record.streak ?? 0),
  ]
  return `| ${cells.join(' | ')} |`
}

function parseRecordRow(line: string): ProgressRecord | null {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = splitTableCells(body)
  // F-11：列数不再静默丢行。concept_id 缺失视为不可恢复；其余字段缺省兜底。
  const conceptId = cells[0]!.replace(/^`|`$/g, '').trim()
  if (conceptId === '') return null
  const dateRaw = cells[7]?.trim() ?? ''
  const nextReviewAt = dateRaw !== '' && dateRaw !== NO_DATE ? dateRaw : null
  return {
    conceptId,
    name: cells[1] ?? conceptId,
    chapter: cells[2] ?? '',
    mastery: parseMasteryCell(cells[3] ?? ''),
    evals: Number(cells[4] ?? 0) || 0,
    passRate: parsePercent(cells[5] ?? ''),
    ef: Number(cells[6] ?? 2.5) || 2.5,
    nextReviewAt,
    misattribution: cells[8] ?? 'none',
    streak: Number(cells[9] ?? 0) || 0,
  }
}

function parsePercent(cell: string): number {
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(cell)
  if (match === null) return 0
  return Math.min(1, Number(match[1]) / 100)
}

/** Load the board; missing file or malformed table yields an empty board. */
export async function loadProgressBoard(path: string): Promise<ProgressBoard> {
  const text = await readFile(path, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/)
  let overallMastery = 0
  let dueCount = 0
  let lastUpdatedAt: string | null = null
  if (MASTERY_RE.test(text)) overallMastery = Math.min(1, Number(MASTERY_RE.exec(text)![1]) / 100)
  if (DUE_RE.test(text)) dueCount = Number(DUE_RE.exec(text)![1])
  if (UPDATED_RE.test(text)) lastUpdatedAt = UPDATED_RE.exec(text)![1]!.trim()
  const concepts: ProgressRecord[] = []
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.includes('concept_id')) { inTable = true; continue }
    if (!inTable) continue
    // F-11：遇非表格行不再 break——旧实现会把标题含换行的记录之后的
    // 所有概念行静默丢弃。空行/分隔行跳过，后续表格行继续收集。
    if (!trimmed.startsWith('|')) continue
    const separator = trimmed.slice(1, -1).replace(/[|\-\s:]/g, '')
    if (separator === '') continue
    const record = parseRecordRow(trimmed)
    if (record !== null) concepts.push(record)
  }
  return { overallMastery, dueCount, lastUpdatedAt, concepts }
}

/** Render + atomic write the whole board (free-form notes after the table kept). */
export async function saveProgressBoard(path: string, board: ProgressBoard, now = new Date()): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes('concept_id')) { headerIdx = i; break }
  }
  let notes = ''
  if (headerIdx >= 0) {
    let idx = headerIdx + 2
    while (idx < lines.length && lines[idx]!.trim().startsWith('|')) idx += 1
    notes = lines.slice(idx).join('\n').trim()
  }
  const concepts = board.concepts
  const overall = concepts.length > 0 ? concepts.reduce((sum, concept) => sum + concept.mastery, 0) / concepts.length : 0
  const today = localDateKey(now)
  const due = concepts.filter(concept => concept.nextReviewAt !== null && concept.nextReviewAt.slice(0, 10) <= today).length
  const rows = [
    '# 学习进度',
    '',
    `- **总体掌握度**：${Math.round(overall * 100)}%`,
    `- **待复习卡片数**：${due}`,
    `- **最后更新时间**：${localDateKey(now)} ${now.toTimeString().slice(0, 5)}`,
    '',
    `| ${COLUMNS.join(' | ')} |`,
    `|${COLUMNS.map(() => '---').join('|')}|`,
    ...concepts.map(renderRecordRow),
    '',
    ...(notes !== '' ? [notes, ''] : []),
  ]
  const tmp = `${path}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  await writeFile(tmp, rows.join('\n'), 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Upsert one record by conceptId (replace or append). */
export function upsertProgressRecord(board: ProgressBoard, record: ProgressRecord): ProgressBoard {
  const exists = board.concepts.some(concept => concept.conceptId === record.conceptId)
  const concepts = exists
    ? board.concepts.map(concept => concept.conceptId === record.conceptId ? record : concept)
    : [...board.concepts, record]
  return { ...board, concepts }
}

/** Records whose next review is due on/before `today`. */
export function dueRecords(board: ProgressBoard, today: string): ProgressRecord[] {
  return board.concepts.filter(record => record.nextReviewAt !== null && record.nextReviewAt.slice(0, 10) <= today)
}

/** SM-2 quality mapping (score ∈ [0,1] → q ∈ [1,5]). */
export function scoreToQuality(score: number): number {
  if (score >= 0.9) return 5
  if (score >= 0.8) return 4
  if (score >= 0.6) return 3
  if (score >= 0.3) return 2
  return 1
}

/** EF 夹在标准 [1.3, 2.9] 区间——上限钳制防止极端序列下无限增长（F-12）。 */
export function updateEf(currentEf: number, quality: number): number {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
  return Math.min(2.9, Math.max(1.3, currentEf + delta))
}

const MAX_INTERVAL_DAYS = 365

export function intervalDays(repetitions: number, ef: number): number {
  if (repetitions <= 1) return 1
  let interval = 3
  for (let i = 3; i <= repetitions; i += 1) {
    interval = Math.round(interval * ef)
    if (interval >= MAX_INTERVAL_DAYS) return MAX_INTERVAL_DAYS
  }
  return Math.max(1, Math.min(MAX_INTERVAL_DAYS, interval))
}

export interface ScheduleState {
  readonly ef: number
  readonly repetitions: number
  readonly intervalDays: number
}

/**
 * One review schedule: pass (q≥3) → repetitions+1 + interval; fail → reset.
 * F-12：`repetitions` 必须传"连续成功次数"（record.streak），而不是累计
 * 评测总数——否则失败重置失效，反复答错的概念复习间隔反而越来越长。
 */
export function reviewSchedule(currentEf: number, repetitions: number, score: number): ScheduleState {
  const quality = scoreToQuality(score)
  const ef = updateEf(currentEf, quality)
  if (quality < 3) return { ef, repetitions: 0, intervalDays: 1 }
  const newN = repetitions + 1
  return { ef, repetitions: newN, intervalDays: intervalDays(newN, ef) }
}
