/** Explicit migration from StudyClaw JSONL history to Agent event JSONL. */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { historyLine, type HistoryLine } from './models.ts'
import { SessionEventStore, type SessionEventEnvelope } from './events.ts'

export interface SessionMigrationResult {
  readonly sessionId: string
  readonly migrated: boolean
  readonly eventFile: string
  readonly backupFile: string | null
  readonly events: number
}

function sourcePath(historyDir: string, sessionId: string): string {
  return join(historyDir, `session_${sessionId}.jsonl`)
}

function eventPath(historyDir: string, sessionId: string): string {
  return join(historyDir, `session_${sessionId}.events.jsonl`)
}

function mapLine(line: HistoryLine, seq: number): Omit<SessionEventEnvelope, 'seq'> {
  const ts = 'ts' in line ? line.ts : 'created_at' in line ? line.created_at : new Date().toISOString()
  switch (line.type) {
    case 'session_meta': return { ts, type: 'session/meta', payload: { title: line.title, mode: line.mode, createdAt: line.created_at } }
    case 'session_model': return { ts, type: 'session/model', payload: { provider: line.provider, model: line.model, ...(line.effort === undefined ? {} : { effort: line.effort }) } }
    case 'chat': return line.role === 'user'
      ? { ts, type: 'user/input', payload: { content: line.content, mode: line.mode ?? null } }
      : { ts, type: 'assistant/message', payload: { content: line.content, mode: line.mode ?? null } }
    case 'tool': return { ts, type: 'tool/result', payload: { callId: `legacy-${seq}`, name: line.name, status: line.status, args: line.args, summary: line.summary, error: line.error, durationMs: line.duration_ms } }
    case 'ask': return line.status === 'pending'
      ? { ts, type: 'ask/pending', payload: { question: line.question } }
      : { ts, type: 'ask/answered', payload: { question: line.question, answer: line.answer ?? '' } }
    case 'sync': return { ts, type: 'sync/applied', payload: { target: line.target, summary: line.summary } }
  }
}

/** Migrate one legacy session without modifying its original JSONL file. */
export async function migrateLegacySession(historyDir: string, sessionId: string): Promise<SessionMigrationResult> {
  const target = eventPath(historyDir, sessionId)
  if ((await stat(target).catch(() => null)) !== null) {
    // A pre-existing event log is authoritative. Validate it before reporting
    // idempotent success so a truncated file can never be mistaken for a
    // completed migration.
    const existing = await new SessionEventStore(historyDir).load(sessionId)
    return { sessionId, migrated: false, eventFile: target, backupFile: (await stat(`${sourcePath(historyDir, sessionId)}.legacy`).catch(() => null)) !== null ? `${sourcePath(historyDir, sessionId)}.legacy` : null, events: existing.length }
  }
  const source = sourcePath(historyDir, sessionId)
  const raw = await readFile(source, 'utf8')
  const events: Array<Omit<SessionEventEnvelope, 'seq'>> = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`旧会话第 ${index + 1} 行不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = historyLine.safeParse(value)
    if (!parsed.success) throw new Error(`旧会话第 ${index + 1} 行无效: ${parsed.error.message}`)
    events.push(mapLine(parsed.data, events.length + 1))
  }
  await mkdir(historyDir, { recursive: true })
  const backup = `${source}.legacy`
  // Never overwrite a user-visible legacy backup. This matters when a prior
  // process copied the source and crashed before atomically publishing the
  // event file.
  if ((await stat(backup).catch(() => null)) === null) await copyFile(source, backup)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  const rows = events.map((event, index) => JSON.stringify({ ...event, seq: index + 1 })).join('\n')
  await writeFile(tmp, rows === '' ? '' : `${rows}\n`, 'utf8')
  await rename(tmp, target)
  return { sessionId, migrated: true, eventFile: target, backupFile: backup, events: events.length }
}
