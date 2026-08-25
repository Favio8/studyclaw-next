/**
 * Progress board: the 9-column markdown contract (`progress.md`) — meta
 * lines, fixed column set with emoji mastery cells, parse/render round-trip,
 * atomic save, due records, and SM-2 scheduling. Ported from Python
 * `progress.py` + `scheduler.py`.
 * @module @studyclaw/learning/src/progress
 */

import { readFile, rename, writeFile } from 'node:fs/promises'

export interface ProgressRecord {
  readonly conceptId: string
  readonly name: string
  readonly chapter: string
  readonly mastery: number
  readonly evals: number
  readonly passRate: number
  readonly ef: number
  readonly nextReviewAt: string | null
  readonly misattribution: string
}

export interface ProgressBoard {
  readonly overallMastery: number
  readonly dueCount: number
  readonly lastUpdatedAt: string | null
  readonly concepts: ProgressRecord[]
}

export const COLUMNS = ['concept_id', 'name', 'chapter', 'mastery', 'evals', 'pass_rate', 'ef', 'next_review_at', 'misattribution'] as const
const NO_DATE = '-'
const MASTERY_CELL_RE = /[🟢🟡🔴]?\s*(\d+(?:\.\d+)?)\s*%/
const MASTERY_RE = /-\s*\*\*总体掌握度\*\*[:：]\s*([\d.]+)%/
const DUE_RE = /-\s*\*\*待复习卡片数\*\*[:：]\s*(\d+)/
const UPDATED_RE = /-\s*\*\*最后更新时间\*\*[:：]\s*([\d\- :]+)/

export function renderMastery(mastery: number): string {
  const emoji = mastery >= 0.7 ? '🟢' : mastery >= 0.4 ? '🟡' : '🔴'
  return `${emoji} ${Math.round(mastery * 100)}%`
}

function parseMasteryCell(cell: string): number {
  const match = MASTERY_CELL_RE.exec(cell)
  if (match === null) return 0
  return Math.min(1, Number(match[1]) / 100)
}

function renderRecordRow(record: ProgressRecord): string {
  const cells = [
    `\`${record.conceptId}\``,
    record.name,
    record.chapter,
    renderMastery(record.mastery),
    String(record.evals),
    `${Math.round(record.passRate * 100)}%`,
    record.ef.toFixed(2),
    record.nextReviewAt !== null ? record.nextReviewAt.slice(0, 10) : NO_DATE,
    record.misattribution,
  ]
  return `| ${cells.join(' | ')} |`
}

function parseRecordRow(line: string): ProgressRecord | null {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
  if (cells.length !== COLUMNS.length) return null
  const dateRaw = cells[7]!
  const nextReviewAt = dateRaw !== '' && dateRaw !== NO_DATE ? dateRaw : null
  return {
    conceptId: cells[0]!.replace(/^`|`$/g, ''),
    name: cells[1]!,
    chapter: cells[2]!,
    mastery: parseMasteryCell(cells[3]!),
    evals: Number(cells[4] ?? 0) || 0,
    passRate: parsePercent(cells[5]!),
    ef: Number(cells[6] ?? 2.5) || 2.5,
    nextReviewAt,
    misattribution: cells[8]!,
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
    if (!trimmed.startsWith('|')) break
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
  const today = now.toISOString().slice(0, 10)
  const due = concepts.filter(concept => concept.nextReviewAt !== null && concept.nextReviewAt.slice(0, 10) <= today).length
  const rows = [
    '# 学习进度',
    '',
    `- **总体掌握度**：${Math.round(overall * 100)}%`,
    `- **待复习卡片数**：${due}`,
    `- **最后更新时间**：${now.toISOString().replace('T', ' ').slice(0, 16)}`,
    '',
    `| ${COLUMNS.join(' | ')} |`,
    `|${COLUMNS.map(() => '---').join('|')}|`,
    ...concepts.map(renderRecordRow),
    '',
    ...(notes !== '' ? [notes, ''] : []),
  ]
  const tmp = path + '.tmp'
  await writeFile(tmp, rows.join('\n'), 'utf8')
  await rename(tmp, path)
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

export function updateEf(currentEf: number, quality: number): number {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
  return Math.max(1.3, currentEf + delta)
}

export function intervalDays(repetitions: number, ef: number): number {
  if (repetitions <= 1) return 1
  let interval = 3
  for (let i = 3; i <= repetitions; i += 1) interval = Math.round(interval * ef)
  return Math.max(1, interval)
}

export interface ScheduleState {
  readonly ef: number
  readonly repetitions: number
  readonly intervalDays: number
}

/** One review schedule: pass (q≥3) → repetitions+1 + interval; fail → reset. */
export function reviewSchedule(currentEf: number, repetitions: number, score: number): ScheduleState {
  const quality = scoreToQuality(score)
  const ef = updateEf(currentEf, quality)
  if (quality < 3) return { ef, repetitions: 0, intervalDays: 1 }
  const newN = repetitions + 1
  return { ef, repetitions: newN, intervalDays: intervalDays(newN, ef) }
}
