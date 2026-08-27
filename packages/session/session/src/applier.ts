/**
 * SyncApplier: applies the hidden `[STUDYCLAW_SYNC]` payload — concept
 * mastery updates rewrite `progress.md` (atomic), memory hints produce a
 * course-evidence audit line (dual-track global promotion is a M2
 * simplification: hints stay course-scoped). Ported from Python
 * `session.py::SyncApplier` / `memory.py::MemoryEngine.register` (reduced).
 * @module @studyclaw/session/src/applier
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncBlock } from './models.ts'
import type { SyncLine } from './models.ts'

const EVIDENCE_TARGET = 'memory_pool'
const EVIDENCE_PREFIX = 'hints: '

/**
 * progress.md 落盘路径：跟随既有文件的所在布局——v2 文件存在则写 v2，
 * 否则沿用根目录旧看板；两者都缺时新建到 `.studyclaw/`（该目录已存在）
 * 或退回根目录，绝不与 builder 的 stateDirOf 写成两份。
 */
async function progressBoardPath(courseDir: string): Promise<string> {
  const v2 = join(courseDir, '.studyclaw', 'progress.md')
  const legacy = join(courseDir, 'progress.md')
  const hasV2 = (await stat(v2).catch(() => null))?.isFile() ?? false
  if (hasV2) return v2
  const hasLegacy = (await stat(legacy).catch(() => null))?.isFile() ?? false
  if (hasLegacy) return legacy
  const hasStateDir = (await stat(join(courseDir, '.studyclaw')).catch(() => null))?.isDirectory() ?? false
  return hasStateDir ? v2 : legacy
}

/** progress.md meta line regexes (Python progress.py parity). */
const MASTERY_RE = /-\s*\*\*总体掌握度\*\*[:：]\s*([\d.]+)%/
const UPDATED_RE = /-\s*\*\*最后更新时间\*\*[:：]\s*([\d\- :]+)/

export function utcTs(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Apply one sync payload: concept_updates → progress.md mastery cells,
 * memory_hints → memory_pool audit line. Returns the audit lines the caller
 * appends to the session file.
 */
export class SyncApplier {
  constructor(
    readonly courseDir: string,
    readonly workspaceRoot: string,
  ) {}

  async apply(payload: SyncBlock, now = new Date()): Promise<SyncLine[]> {
    const lines: SyncLine[] = []
    const progressSummary = await this.applyConceptUpdates(payload.concept_updates)
    if (progressSummary !== '') {
      lines.push({ type: 'sync', ts: utcTs(now), target: 'progress.md', summary: progressSummary })
    }
    if (payload.memory_hints.length > 0) {
      lines.push({
        type: 'sync',
        ts: utcTs(now),
        target: EVIDENCE_TARGET,
        summary: EVIDENCE_PREFIX + payload.memory_hints.join('；'),
      })
    }
    return lines
  }

  private async conceptFacts(): Promise<Map<string, { name: string; chapter: string }>> {
    // 大纲在 v2 布局下位于 .studyclaw/syllabus.json；旧布局根目录兜底。
    const v2 = join(this.courseDir, '.studyclaw', 'syllabus.json')
    const legacy = join(this.courseDir, 'syllabus.json')
    let raw: string | null = null
    for (const path of [v2, legacy]) {
      raw = await readFile(path, 'utf8').catch(() => null)
      if (raw !== null) break
    }
    const map = new Map<string, { name: string; chapter: string }>()
    if (raw === null) return map
    try {
      const parsed = JSON.parse(raw) as { chapters?: Array<{ title?: string; concepts?: Array<{ id?: string; name?: string }> }> }
      for (const chapter of parsed.chapters ?? []) {
        for (const concept of chapter.concepts ?? []) {
          if (typeof concept.id === 'string' && concept.id !== '') {
            map.set(concept.id, { name: typeof concept.name === 'string' ? concept.name : concept.id, chapter: typeof chapter.title === 'string' ? chapter.title : '' })
          }
        }
      }
    } catch {
      // Corrupt syllabus: empty index (rows fall back to id-as-name).
    }
    return map
  }

  private async applyConceptUpdates(updates: Array<{ id: string; score: number }>): Promise<string> {
    if (updates.length === 0) return ''
    const path = await progressBoardPath(this.courseDir)
    const facts = await this.conceptFacts()
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) {
      // No board yet: create one with the updated concepts (best-effort M2 form).
      const header = ['| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
        '|---|---|---|---|---|---|---|---|---|']
      const rows = updates.map(update => {
        const name = facts.get(update.id)?.name ?? update.id
        const chapter = facts.get(update.id)?.chapter ?? ''
        return `| ${update.id} | ${name} | ${chapter} | ${Math.round(update.score * 100)}% | 0 | 0% | 2.5 | | none |`
      })
      const newBoard = [`# 学习进度`, '', `- **总体掌握度**：${Math.round(mean(updates.map(u => u.score)) * 100)}%`, `- **待复习卡片数**：0`, `- **最后更新时间**：${utcTs().replace('T', ' ').slice(0, 16)}`, '', ...header, ...rows, '']
      await atomicWrite(path, newBoard.join('\n'))
      return updates.map(update => `${update.id} 掌握度 0%→${Math.round(update.score * 100)}%`).join('；')
    }
    const lines = text.split(/\r?\n/)
    let headerIdx = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.includes('concept_id')) { headerIdx = i; break }
    }
    const seen = new Set<string>()
    const parts: string[] = []
    const byId = new Map(updates.map(update => [update.id, update]))
    const normId = (raw: string): string => raw.trim().replace(/^`|`$/g, '')
    /** 拆出净内容列（去掉表行首尾管道造成的空单元），保证回写后仍是标准 9 列。 */
    const rowCells = (line: string): string[] | null => {
      let cells = line.split('|').map(cell => cell.trim())
      if ((cells[0] ?? '') === '') cells = cells.slice(1)
      if (cells.length > 0 && (cells[cells.length - 1] ?? '') === '') cells = cells.slice(0, -1)
      return cells.length >= 3 ? cells : null
    }
    const headerCells = headerIdx >= 0 ? rowCells(lines[headerIdx]!) : null
    const masteryIdx = headerCells !== null ? Math.max(0, headerCells.indexOf('mastery')) : 3
    if (headerIdx >= 0) {
      for (let i = headerIdx + 2; i < lines.length; i += 1) {
        const line = lines[i]!
        if (!line.trim().startsWith('|')) break
        const separatorProbe = line.trim().slice(1, -1).replace(/[|\-\s:]/g, '')
        if (separatorProbe === '') continue
        const cells = rowCells(line)
        if (cells === null) continue
        const id = normId(cells[0] ?? '')
        const update = byId.get(id)
        if (update === undefined) continue
        seen.add(id)
        const before = parseMastery(cells[masteryIdx] ?? '0')
        cells[masteryIdx] = `${Math.round(update.score * 100)}%`
        lines[i] = `| ${cells.join(' | ')} |`
        parts.push(`${id} 掌握度 ${Math.round(before * 100)}%→${Math.round(update.score * 100)}%`)
      }
    }
    for (const update of updates) {
      if (seen.has(update.id)) continue
      const name = facts.get(update.id)?.name ?? update.id
      const chapter = facts.get(update.id)?.chapter ?? ''
      const row = `| ${update.id} | ${name} | ${chapter} | ${Math.round(update.score * 100)}% | 0 | 0% | 2.5 | | none |`
      const insertAt = headerIdx >= 0 ? headerIdx + 2 : 0
      lines.splice(Math.min(insertAt, lines.length), 0, row)
      parts.push(`${update.id} 掌握度 0%→${Math.round(update.score * 100)}%`)
    }
    if (parts.length === 0) return ''
    const updatedText = lines.join('\n')
      .replace(MASTERY_RE, (_m, value: string) => `- **总体掌握度**：${value}%`)
      .replace(UPDATED_RE, () => `- **最后更新时间**：${utcTs().replace('T', ' ').slice(0, 16)}`)
    await atomicWrite(path, updatedText)
    return parts.join('；')
  }
}

function parseMastery(raw: string): number {
  if (raw.endsWith('%')) return Math.min(1, Number(raw.slice(0, -1)) / 100)
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}
