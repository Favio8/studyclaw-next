/**
 * SyncApplier: applies the hidden `[STUDYCLAW_SYNC]` payload — concept
 * mastery updates rewrite `progress.md` (atomic), memory hints produce a
 * course-evidence audit line (dual-track global promotion is a M2
 * simplification: hints stay course-scoped). Ported from Python
 * `session.py::SyncApplier` / `memory.py::MemoryEngine.register` (reduced).
 * @module @studyclaw/session/src/applier
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncBlock } from './models.ts'
import type { SyncLine } from './models.ts'

const EVIDENCE_TARGET = 'memory_pool'
const EVIDENCE_PREFIX = 'hints: '

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

  private async applyConceptUpdates(updates: Array<{ id: string; score: number }>): Promise<string> {
    if (updates.length === 0) return ''
    const path = join(this.courseDir, 'progress.md')
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) {
      // No board yet: create one with the updated concepts (best-effort M2 form).
      const header = ['| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
        '|---|---|---|---|---|---|---|---|---|']
      const rows = updates.map(update => {
        const name = this.conceptName(update.id)
        return `| ${update.id} | ${name} | | ${Math.round(update.score * 100)}% | 0 | 0% | 2.5 | | none |`
      })
      const newBoard = [`# 学习进度`, '', `- **总体掌握度**：${Math.round(mean(updates.map(u => u.score)) * 100)}%`, `- **待复习卡片数**：0`, `- **最后更新时间**：${utcTs().replace('T', ' ').slice(0, 16)}`, '', ...header, ...rows, '']
      await atomicWrite(path, newBoard.join('\n'))
      return updates.map(update => `${update.id} 掌握度 0%→${Math.round(update.score * 100)}%`).join('；')
    }
    const lines = text.split(/\r?\n/)
    let headerIdx = -1
    let masteryIdx = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.includes('concept_id')) { headerIdx = i; break }
    }
    if (headerIdx >= 0) {
      const headerCells = lines[headerIdx]!.split('|').map(cell => cell.trim())
      masteryIdx = headerCells.indexOf('mastery')
      if (masteryIdx < 0) masteryIdx = 3
    }
    const seen = new Set<string>()
    const parts: string[] = []
    const byId = new Map(updates.map(update => [update.id, update]))
    if (headerIdx >= 0 && masteryIdx >= 0) {
      for (let i = headerIdx + 2; i < lines.length; i += 1) {
        const line = lines[i]!
        if (!line.trim().startsWith('|')) break
        const cells = line.split('|').map(cell => cell.trim())
        const id = cells[1] ?? ''
        const update = byId.get(id)
        if (update === undefined) continue
        seen.add(id)
        const before = parseMastery(cells[masteryIdx] ?? '0')
        cells[masteryIdx] = `${Math.round(update.score * 100)}%`
        lines[i] = cells.map((cell, index) => (index === 0 ? `| ${cell}` : index === cells.length - 1 ? ` ${cell} |` : ` ${cell} |`)).join('')
        parts.push(`${id} 掌握度 ${Math.round(before * 100)}%→${Math.round(update.score * 100)}%`)
      }
    }
    for (const update of updates) {
      if (seen.has(update.id)) continue
      const name = this.conceptName(update.id)
      const row = `| ${update.id} | ${name} | | ${Math.round(update.score * 100)}% | 0 | 0% | 2.5 | | none |`
      const insertAt = headerIdx >= 0 ? headerIdx + 2 + (lines.filter((line, idx) => idx > headerIdx && line.trim().startsWith('|') && !line.trim().replace(/[|-\s:]/g, '').startsWith('') && idx > headerIdx + 1).length) : 0
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

  private conceptName(conceptId: string): string {
    return conceptId
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
