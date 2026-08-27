/**
 * SessionStore: one append-only JSONL file per session
 * (`history/session_<YYYYMMDD-HHMMSS>.jsonl`, meta line first, mtime decides
 * recency). Ported from Python `session.py::SessionStore`.
 * @module @studyclaw/session/src/store
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { chatLine, sessionMetaLine, sessionModelLine, type ChatLine, type HistoryLine, type LearningMode, type SessionMetaLine, type SessionModelLine } from './models.ts'

const SESSION_FILE_RE = /^session_(\d{8}-\d{6})\.jsonl$/
const EVENT_FILE_RE = /^session_(\d{8}-\d{6})\.events\.jsonl$/
const SESSION_ID_RE = /^\d{8}-\d{6}$/

export class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

/** UTC timestamp in file-contract form: `YYYY-MM-DDTHH:MM:SSZ`. */
export function utcTs(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly mode: LearningMode
  readonly createdAt: string
  readonly mtimeMs: number
}

/** JSONL line serializer: UTF-8 verbatim, snake_case fields. */
function dumps(line: HistoryLine): string {
  return JSON.stringify(line)
}

/**
 * The multi-session JSONL store for one course's `history/` directory.
 */
export class SessionStore {
  constructor(readonly historyDir: string) {}

  /** Read title/mode metadata emitted by the event-log runtime. */
  private async eventSummary(sessionId: string): Promise<{ title: string; mode: LearningMode; createdAt: string; archived: boolean; userNamed: boolean; autoProvenance: 'fallback' | 'llm' | '' } | null> {
    const path = join(this.historyDir, `session_${sessionId}.events.jsonl`)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) return null
    let title = ''
    let userNamed = false
    let autoProvenance: 'fallback' | 'llm' | '' = ''
    let mode: LearningMode = 'socratic'
    let createdAt = ''
    let archived = false
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue
      try {
        const row = JSON.parse(raw) as { type?: string; ts?: string; payload?: Record<string, unknown> }
        const payload = row.payload ?? {}
        if (row.type === 'session/create' || row.type === 'session/meta') {
          if (payload['mode'] === 'quick' || payload['mode'] === 'feynman' || payload['mode'] === 'debug' || payload['mode'] === 'socratic') mode = payload['mode']
          if (typeof payload['title'] === 'string' && payload['title'].trim() !== '') title = payload['title'].trim()
          if (typeof payload['createdAt'] === 'string' && payload['createdAt'] !== '') createdAt = payload['createdAt']
          if (typeof row.ts === 'string' && row.ts !== '') createdAt = row.ts
        }
        if (row.type === 'session/rename' && typeof payload['title'] === 'string') {
          title = payload['title'].trim()
          userNamed = true
          autoProvenance = ''
        }
        // Automatic titles never override a user rename (DSH pin semantics).
        if (row.type === 'session/title' && !userNamed && typeof payload['title'] === 'string' && payload['title'].trim() !== '') {
          title = payload['title'].trim()
          autoProvenance = payload['provenance'] === 'llm' ? 'llm' : 'fallback'
        }
        if (row.type === 'session/archive') archived = true
        if (row.type === 'user/input' && title === '') {
          const content = typeof payload['content'] === 'string' ? payload['content'] : ''
          if (content !== '') title = content.slice(0, 20)
        }
      } catch {
        // A malformed event is ignored here; SessionEventStore validates on replay.
      }
    }
    return { title, mode, createdAt, archived, userNamed, autoProvenance }
  }

  private archivePath(): string {
    return join(this.historyDir, '.archived.json')
  }

  private sessionOrderPath(): string {
    return join(this.historyDir, '.session-order.json')
  }

  private async archivedIds(): Promise<Set<string>> {
    const text = await readFile(this.archivePath(), 'utf8').catch(() => null)
    if (text === null) return new Set()
    try {
      const parsed = JSON.parse(text) as unknown
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && SESSION_ID_RE.test(id)) : [])
    } catch {
      return new Set()
    }
  }

  /**
   * Read the user-edited order. `null` means no manual order has been saved;
   * an invalid file is treated as an empty order and healed on the next list.
   */
  private async sessionOrder(): Promise<string[] | null> {
    const text = await readFile(this.sessionOrderPath(), 'utf8').catch(() => null)
    if (text === null) return null
    try {
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return []
      const seen = new Set<string>()
      const order: string[] = []
      for (const value of parsed) {
        if (typeof value !== 'string' || !SESSION_ID_RE.test(value) || seen.has(value)) continue
        seen.add(value)
        order.push(value)
      }
      return order
    } catch {
      return []
    }
  }

  private async writeSessionOrder(order: readonly string[]): Promise<void> {
    await mkdir(this.historyDir, { recursive: true })
    const path = this.sessionOrderPath()
    const tmp = path + '.tmp'
    await writeFile(tmp, JSON.stringify(order) + '\n', 'utf8')
    await rename(tmp, path)
  }

  async newSession(
    mode: LearningMode = 'socratic',
    title: string | null = null,
    now = new Date(),
  ): Promise<{ sessionId: string; path: string }> {
    await mkdir(this.historyDir, { recursive: true })
    const compact = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const sessionId = `${compact.slice(0, 8)}-${compact.slice(8)}`
    const path = this.pathFor(sessionId)
    if ((await stat(path).catch(() => null)) !== null) {
      throw new SessionError(`会话已存在: ${sessionId}（同一秒内请勿重复创建）`)
    }
    const meta: SessionMetaLine = {
      type: 'session_meta',
      title: title ?? '',
      mode,
      created_at: now.toISOString(),
    }
    await writeFile(path, dumps(meta) + '\n', 'utf8')
    return { sessionId, path }
  }

  /**
   * Session summaries in persisted manual order when it exists, otherwise
   * mtime-descending. Stale order ids are removed and newly seen sessions are
   * appended in deterministic recency order, matching dsh reconciliation.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const dir = await stat(this.historyDir).catch(() => null)
    if (dir === null || !dir.isDirectory()) return []
    const { readdir } = await import('node:fs/promises')
    const archived = await this.archivedIds()
    const infos: SessionSummary[] = []
    const names = await readdir(this.historyDir)
    const legacyIds = new Set(names.flatMap(name => {
      const match = SESSION_FILE_RE.exec(name)
      return match === null ? [] : [match[1]!]
    }))
    for (const name of names) {
      const match = SESSION_FILE_RE.exec(name)
      const eventMatch = EVENT_FILE_RE.exec(name)
      if (match === null && eventMatch === null) continue
      const id = match?.[1] ?? eventMatch?.[1]!
      const eventSummary = eventMatch === null ? null : await this.eventSummary(id)
      if (archived.has(id) || (eventSummary?.archived ?? false) || (eventMatch !== null && legacyIds.has(id))) continue
      const info = await stat(join(this.historyDir, name))
      if (match !== null) {
        const meta = await this.readMeta(id)
        const event = eventSummary ?? await this.eventSummary(id)
        infos.push({
          id,
          title: event?.title || meta?.title || '',
          mode: meta?.mode ?? event?.mode ?? 'socratic',
          createdAt: event?.createdAt || meta?.created_at || '',
          mtimeMs: info.mtimeMs,
        })
        continue
      }
      const event = eventSummary ?? await this.eventSummary(id)
      let title = event?.title ?? ''
      let userNamed = false
      let mode: LearningMode = event?.mode ?? 'socratic'
      let createdAt = info.mtimeMs > 0 ? new Date(info.mtimeMs).toISOString() : ''
      const text = await readFile(join(this.historyDir, name), 'utf8').catch(() => '')
      for (const raw of text.split(/\r?\n/)) {
        if (raw.trim() === '') continue
        try {
          const row = JSON.parse(raw) as { type?: string; ts?: string; payload?: Record<string, unknown> }
          if (row.type === 'session/create') {
            mode = row.payload?.['mode'] === 'quick' || row.payload?.['mode'] === 'feynman' || row.payload?.['mode'] === 'debug' ? row.payload['mode'] : 'socratic'
            title = typeof row.payload?.['title'] === 'string' && row.payload['title'] !== '' ? row.payload['title'] : title
            createdAt = row.ts ?? createdAt
          }
          if (row.type === 'session/rename' && typeof row.payload?.['title'] === 'string') {
            title = String(row.payload['title'])
            userNamed = true
          }
          if (row.type === 'session/title' && !userNamed && typeof row.payload?.['title'] === 'string' && row.payload['title'] !== '') {
            title = String(row.payload['title'])
          }
          if (row.type === 'user/input' && title === '') title = String(row.payload?.['content'] ?? '').slice(0, 20)
        } catch { /* corrupt event rows are validated by SessionEventStore */ }
      }
      infos.push({ id, title, mode, createdAt, mtimeMs: info.mtimeMs })
    }
    // mtime desc; equal mtimes (same-millisecond writes) break by id desc so
    // the order stays deterministic on any filesystem.
    const recent = infos.sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id))
    const stored = await this.sessionOrder()
    if (stored === null) return recent

    const byId = new Map(recent.map(session => [session.id, session]))
    const reconciled: SessionSummary[] = []
    const included = new Set<string>()
    for (const id of stored) {
      const session = byId.get(id)
      if (session === undefined || included.has(id)) continue
      reconciled.push(session)
      included.add(id)
    }
    for (const session of recent) {
      if (included.has(session.id)) continue
      reconciled.push(session)
    }
    const reconciledIds = reconciled.map(session => session.id)
    if (stored.length !== reconciledIds.length || stored.some((id, index) => id !== reconciledIds[index])) {
      await this.writeSessionOrder(reconciledIds)
    }
    return reconciled
  }

  /** Move one visible session before another one (or to the end when omitted). */
  async insertSessionBefore(sessionId: string, beforeId?: string): Promise<SessionSummary[]> {
    const sessions = await this.listSessions()
    if (!sessions.some(session => session.id === sessionId)) {
      throw new SessionError(`会话不存在: ${sessionId}`)
    }
    if (beforeId === sessionId) return sessions
    if (beforeId !== undefined && !sessions.some(session => session.id === beforeId)) {
      throw new SessionError(`会话不存在: ${beforeId}`)
    }
    const reordered = sessions.filter(session => session.id !== sessionId)
    const insertAt = beforeId === undefined
      ? reordered.length
      : reordered.findIndex(session => session.id === beforeId)
    reordered.splice(insertAt, 0, sessions.find(session => session.id === sessionId)!)
    await this.writeSessionOrder(reordered.map(session => session.id))
    return reordered
  }

  async latestSessionId(): Promise<string | null> {
    const sessions = await this.listSessions()
    const latest = sessions.reduce<SessionSummary | null>((candidate, session) => {
      if (candidate === null) return session
      return session.mtimeMs > candidate.mtimeMs
        || (session.mtimeMs === candidate.mtimeMs && session.id.localeCompare(candidate.id) > 0)
        ? session
        : candidate
    }, null)
    return latest?.id ?? null
  }

  pathFor(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) throw new SessionError(`非法会话 ID: ${sessionId}`)
    return join(this.historyDir, `session_${sessionId}.jsonl`)
  }

  async readMeta(sessionId: string): Promise<SessionMetaLine | null> {
    const path = this.pathFor(sessionId)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) return null
    const first = text.split(/\r?\n/, 1)[0] ?? ''
    if (first === '') return null
    let line: unknown
    try {
      line = JSON.parse(first)
    } catch {
      return null
    }
    if (typeof line !== 'object' || line === null || (line as { type?: string }).type !== 'session_meta') return null
    return sessionMetaLine.parse(line)
  }

  /** Read every raw JSON row (tolerates corrupt lines: skipped). */
  async load(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const path = this.pathFor(sessionId)
    if ((await stat(path).catch(() => null)) === null) throw new SessionError(`会话不存在: ${sessionId}`)
    const text = await readFile(path, 'utf8')
    const rows: Array<Record<string, unknown>> = []
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed === 'object') rows.push(parsed)
      } catch {
        // Corrupt row: skipped.
      }
    }
    return rows
  }

  /** Restore chat context: only `chat` rows in file order. */
  async loadChat(sessionId: string): Promise<ChatLine[]> {
    const chats: ChatLine[] = []
    for (const row of await this.load(sessionId)) {
      if (row['type'] === 'chat') chats.push(chatLine.parse(row))
    }
    return chats
  }

  /** Return the latest durable model selection, if this session has one. */
  async latestModel(sessionId: string): Promise<SessionModelLine | null> {
    let latest: SessionModelLine | null = null
    for (const row of await this.load(sessionId)) {
      if (row['type'] !== 'session_model') continue
      const parsed = sessionModelLine.safeParse(row)
      if (parsed.success) latest = parsed.data
    }
    return latest
  }

  /** Append-only write (§3.4: existing lines are never rewritten). */
  async append(sessionId: string, ...lines: HistoryLine[]): Promise<void> {
    const path = this.pathFor(sessionId)
    if ((await stat(path).catch(() => null)) === null) throw new SessionError(`会话不存在: ${sessionId}`)
    await writeFile(path, lines.map(dumps).join('\n') + '\n', { encoding: 'utf8', flag: 'a' })
  }

  /**
   * Title backfill: the only permitted meta update — first user chat's first
   * 20 chars when the title is still empty. Rewrites line 1 only (atomic).
   */
  async fillDefaultTitle(sessionId: string, userText: string): Promise<void> {
    const meta = await this.readMeta(sessionId)
    if (meta === null || meta.title !== '') return
    const path = this.pathFor(sessionId)
    const text = await readFile(path, 'utf8')
    const rows = text.split(/\r?\n/)
    rows[0] = dumps({ ...meta, title: userText.slice(0, 20) })
    const tmp = path + '.tmp'
    await writeFile(tmp, rows.join('\n'), 'utf8')
    await rename(tmp, path)
  }

  /** Explicitly rename a session by rewriting only its metadata line. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (await stat(join(this.historyDir, `session_${sessionId}.events.jsonl`)).catch(() => null)) {
      const { SessionEventStore } = await import('./events.ts')
      await new SessionEventStore(this.historyDir).append(sessionId, { ts: utcTs(), type: 'session/rename', payload: { title: title.trim() } })
      return
    }
    const meta = await this.readMeta(sessionId)
    if (meta === null) throw new SessionError(`会话不存在: ${sessionId}`)
    const path = this.pathFor(sessionId)
    const text = await readFile(path, 'utf8')
    const rows = text.split(/\r?\n/)
    rows[0] = dumps({ ...meta, title: title.trim() })
    const tmp = path + '.tmp'
    await writeFile(tmp, rows.join('\n'), 'utf8')
    await rename(tmp, path)
  }

  /**
   * Append an automatic `session/title` event under DSH semantics: a user
   * rename (or explicit creation title) pins the title; a `fallback` write
   * happens at most once; an `llm` write only upgrades an earlier fallback.
   * Returns whether the event was written.
   */
  async applyAutoTitle(sessionId: string, title: string, provenance: 'fallback' | 'llm', route?: { provider: string; model: string }): Promise<boolean> {
    const trimmed = title.trim()
    if (trimmed === '') return false
    const eventsPath = join(this.historyDir, `session_${sessionId}.events.jsonl`)
    if ((await stat(eventsPath).catch(() => null)) === null) return false
    const meta = await this.readMeta(sessionId).catch(() => null)
    if ((meta?.title ?? '') !== '') return false
    const summary = await this.eventSummary(sessionId).catch(() => null)
    if (summary !== null) {
      if (summary.userNamed) return false
      if (provenance === 'fallback' && summary.title !== '') return false
      if (provenance === 'llm' && summary.autoProvenance !== 'fallback') return false
    }
    const { SessionEventStore } = await import('./events.ts')
    await new SessionEventStore(this.historyDir).append(sessionId, {
      ts: utcTs(),
      type: 'session/title',
      payload: { title: trimmed, provenance, ...(route === undefined ? {} : { provider: route.provider, model: route.model }) },
    })
    return true
  }

  /**
   * Copy a session into a new JSONL file. `throughChatIndex` retains the
   * selected chat row and every audit row before it; omitting it keeps the
   * original complete-history fork behavior.
   */
  async forkSession(
    sessionId: string,
    now = new Date(),
    throughChatIndex?: number,
  ): Promise<{ sessionId: string; path: string }> {
    const sourcePath = this.pathFor(sessionId)
    const source = await readFile(sourcePath, 'utf8').catch(() => null)
    if (source === null) throw new SessionError(`会话不存在: ${sessionId}`)
    const sourceMeta = await this.readMeta(sessionId)
    if (throughChatIndex !== undefined && (!Number.isInteger(throughChatIndex) || throughChatIndex < 0)) {
      throw new SessionError('分支位置无效')
    }
    let copied = source
    if (throughChatIndex !== undefined) {
      const rows: string[] = []
      let chatIndex = 0
      let found = false
      for (const raw of source.split(/\r?\n/)) {
        if (raw === '') continue
        rows.push(raw)
        try {
          const parsed = chatLine.safeParse(JSON.parse(raw))
          if (!parsed.success) continue
          if (chatIndex === throughChatIndex) {
            found = true
            break
          }
          chatIndex += 1
        } catch {
          // Corrupt audit lines are preserved just like a full-history fork.
        }
      }
      if (!found) throw new SessionError('分支位置不存在')
      copied = rows.join('\n') + '\n'
    }
    await mkdir(this.historyDir, { recursive: true })
    const base = new Date(now)
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const candidate = new Date(base.getTime() + attempt * 1000)
      const compact = candidate.toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const forkId = `${compact.slice(0, 8)}-${compact.slice(8)}`
      const path = this.pathFor(forkId)
      if ((await stat(path).catch(() => null)) !== null) continue
      const rows = copied.split(/\r?\n/)
      rows[0] = dumps({
        type: 'session_meta',
        title: `${sourceMeta?.title || '未命名会话'}（副本）`,
        mode: sourceMeta?.mode ?? 'socratic',
        created_at: candidate.toISOString(),
      })
      await writeFile(path, rows.join('\n'), 'utf8')
      return { sessionId: forkId, path }
    }
    throw new SessionError('无法创建会话副本：时间戳冲突')
  }

  /** Archive a session without deleting its JSONL history. */
  async archiveSession(sessionId: string): Promise<void> {
    if (await stat(join(this.historyDir, `session_${sessionId}.events.jsonl`)).catch(() => null)) {
      const { SessionEventStore } = await import('./events.ts')
      await new SessionEventStore(this.historyDir).append(sessionId, { ts: utcTs(), type: 'session/archive', payload: {} })
      return
    }
    await this.load(sessionId)
    const archived = await this.archivedIds()
    archived.add(sessionId)
    await mkdir(this.historyDir, { recursive: true })
    await writeFile(this.archivePath(), JSON.stringify([...archived]) + '\n', 'utf8')
    const order = await this.sessionOrder()
    if (order !== null && order.includes(sessionId)) {
      await this.writeSessionOrder(order.filter(id => id !== sessionId))
    }
  }
}

/** zod-discriminated history line for boundary validation reuse. */
export const historyLineSchema = z.discriminatedUnion('type', [
  sessionMetaLine,
  sessionModelLine,
  chatLine,
])
