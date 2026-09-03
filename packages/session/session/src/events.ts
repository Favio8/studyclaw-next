/**
 * DSH-style append-only session event log and projection primitives.
 *
 * The envelope is deliberately small and provider-neutral. Agent/runtime
 * packages own event names and payloads; this package owns sequence ordering,
 * durable validation, replay, and atomic append semantics.
 * @module @studyclaw/session/events
 */

import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { utcTs } from './store.ts'

export const sessionEventEnvelope = z.object({
  seq: z.number().int().positive(),
  ts: z.string().min(1),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
})
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelope>

/** DSH-style terminal reason carried by a completed turn boundary. */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked'; blockers?: Array<'ask-user' | 'approval'> }
  | { kind: 'max-tokens'; limit?: number }
  | { kind: 'aborted'; reason: { kind: 'user' | 'system' | 'disposed' | 'error' | 'parent' | 'legacy'; reason?: string } }
  | { kind: 'error'; error: { message: string; code: string; [key: string]: unknown } }
  | { kind: 'interrupted' }

/**
 * Core durable event vocabulary shared by Agent, Host, ACP and Web.
 *
 * The envelope intentionally keeps `type` open for plugin events, while this
 * map gives first-party consumers a single source of truth for the events
 * they project. Unknown events remain replayable and are ignored by the
 * projection until a plugin claims them.
 */
export interface SessionEventMap {
  'session/create': { mode?: string; agentId?: string; parentAgentId?: string; parentSessionId?: string }
  'session/model': { provider: string; model: string; effort?: string; cleared?: boolean }
  'session/fork': { parentSessionId: string; forkSeq: number }
  'session/rename': { title: string }
  /** Automatic title with provenance (DSH session-title parity); a user rename supersedes it. */
  'session/title': { title: string; provenance: 'fallback' | 'llm'; provider?: string; model?: string }
  'agent/runtime': Record<string, unknown>
  'agent/config': Record<string, unknown>
  'agent/context': Record<string, unknown>
  'agent/child': { childAgentId: string; childSessionId: string; parentAgentId?: string }
  'prompt/assembled': { system: string; user: string; mode?: string }
  'inbox/queued': Record<string, unknown>
  'inbox/dequeued': Record<string, unknown>
  /** A next-step item was admitted into the current turn and fully consumed. */
  'inbox/admitted': Record<string, unknown>
  'inbox/replaced': Record<string, unknown>
  'inbox/dropped': Record<string, unknown>
  'turn/start': Record<string, unknown>
  'turn/recovered': Record<string, unknown>
  'turn/end': { reason?: TurnEndReason }
  'turn/error': { message: string }
  'turn/cancelled': { reason: string }
  'step/start': Record<string, unknown>
  'step/end': Record<string, unknown>
  'step/error': { message: string; attempt?: number }
  'request/header': Record<string, unknown>
  'request/start': Record<string, unknown>
  'request/end': Record<string, unknown>
  'request/error': { message: string; attempt?: number }
  'request/retry': { message: string; attempt: number }
  'user/input': { content: string; [key: string]: unknown }
  /** Compensating marker for the append-only log: the referenced user/input
   * turn failed before producing any durable output (no assistant message,
   * no tool activity), so the input is excluded from conversations and
   * replay. This keeps a failed-then-retried turn from leaving a duplicate
   * user message behind. */
  'input/voided': { seq: number; reason?: string }
  /** A5（第三轮审查）：与 input/voided 对称的补偿标记——失败重试新开 turn
   * 时，旧 turn 已落盘的部分 assistant 输出一并从投影剔除，否则会留下
   * 没有对应用户消息的孤儿回复，且重连 Last-Event-ID 的序号口径漂移。 */
  'assistant/voided': { seq: number; reason?: string }
  'assistant/chunk': { delta: string }
  'assistant/reasoning': { delta: string }
  'assistant/message': { content: string; provider?: string; model?: string; interrupted?: true }
  'tool/call': Record<string, unknown>
  'tool/result': Record<string, unknown>
  'ask/pending': { question: string }
  'ask/answered': { question: string; answer: string }
  'approval/pending': Record<string, unknown>
  'approval/resolved': { requestId: string; decision: string }
  'plan/update': Record<string, unknown>
  'todo/update': Record<string, unknown>
  'sync/applied': Record<string, unknown>
  'usage': Record<string, unknown>
  'maintenance/queued': Record<string, unknown>
  'maintenance/start': Record<string, unknown>
  'maintenance/end': Record<string, unknown>
  'maintenance/error': Record<string, unknown>
  'compaction/applied': Record<string, unknown>
  'model/provenance': Record<string, unknown>
  'session/disposed': Record<string, unknown>
}

export type SessionEventName = keyof SessionEventMap
export type KnownSessionEventEnvelope<T extends SessionEventName = SessionEventName> = Omit<SessionEventEnvelope, 'type' | 'payload'> & {
  type: T
  payload: SessionEventMap[T]
}

const turnEndReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }),
  z.object({ kind: z.literal('blocked'), blockers: z.array(z.enum(['ask-user', 'approval'])).optional() }),
  z.object({ kind: z.literal('max-tokens'), limit: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('aborted'), reason: z.object({ kind: z.enum(['user', 'system', 'disposed', 'error', 'parent', 'legacy']), reason: z.string().min(1).optional() }) }),
  z.object({ kind: z.literal('error'), error: z.object({ message: z.string().min(1), code: z.string().min(1) }).passthrough() }),
  z.object({ kind: z.literal('interrupted') }),
])

/** Runtime validation for first-party events with a stable payload contract.
 * Open-ended plugin events still use append()/appendUnknown(). */
const knownPayloadSchemas: Partial<Record<SessionEventName, z.ZodTypeAny>> = {
  'session/model': z.object({ provider: z.string().min(1), model: z.string().min(1), effort: z.string().min(1).optional(), cleared: z.boolean().optional() }).passthrough(),
  'session/fork': z.object({ parentSessionId: z.string().min(1), forkSeq: z.number().int().nonnegative() }).passthrough(),
  'session/rename': z.object({ title: z.string().min(1) }).passthrough(),
  'session/title': z.object({ title: z.string().min(1), provenance: z.enum(['fallback', 'llm']), provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).passthrough(),
  'turn/end': z.object({ reason: turnEndReasonSchema.optional() }).passthrough(),
  'turn/error': z.object({ message: z.string().min(1) }).passthrough(),
  'turn/cancelled': z.object({ reason: z.string().min(1) }).passthrough(),
  'step/error': z.object({ message: z.string().min(1), attempt: z.number().int().nonnegative().optional() }).passthrough(),
  'request/error': z.object({ message: z.string().min(1), attempt: z.number().int().nonnegative().optional() }).passthrough(),
  'request/retry': z.object({ message: z.string().min(1), attempt: z.number().int().nonnegative() }).passthrough(),
  'user/input': z.object({ content: z.string() }).passthrough(),
  'input/voided': z.object({ seq: z.number().int().positive() }).passthrough(),
  'assistant/voided': z.object({ seq: z.number().int().positive() }).passthrough(),
  'assistant/chunk': z.object({ delta: z.string() }).passthrough(),
  'assistant/reasoning': z.object({ delta: z.string() }).passthrough(),
  'assistant/message': z.object({ content: z.string(), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), interrupted: z.literal(true).optional() }).passthrough(),
  'ask/pending': z.object({ question: z.string().min(1) }).passthrough(),
  'ask/answered': z.object({ question: z.string(), answer: z.string() }).passthrough(),
  'approval/resolved': z.object({ requestId: z.string().min(1), decision: z.string().min(1) }).passthrough(),
}

export interface SessionProjection {
  readonly sessionId: string
  readonly phase: 'idle' | 'queued' | 'running' | 'waiting' | 'cancelled' | 'disposed'
  readonly currentModel: { provider: string; model: string; effort?: string } | null
  readonly modelProvenance: { provider: string; model: string; effort: string | null; requestId: string | null }
  readonly agentConfig: {
    agentPreset: string
    permissionPreset: 'read-only' | 'workspace-write' | 'danger-full-access'
    plugins: Record<string, boolean>
    cwd?: string
    capabilities?: Array<{ id: string; available: boolean; reason: string | null; installAction: string | null }>
    scope?: { agentId: string; sessionId: string; cwd: string; workspaceRoot?: string; courseId?: string }
    systemPrompt?: string
  } | null
  /** Immutable runtime facts persisted by the live Agent facade. */
  readonly agentRuntime: {
    agentId: string
    sessionId: string
    cwd: string
    preset: Record<string, unknown>
    permissionPreset: 'read-only' | 'workspace-write' | 'danger-full-access'
    capabilities: Array<{ id: string; available: boolean; reason: string | null; installAction: string | null }>
    systemPrompt: string
  } | null
  readonly messages: Array<{ role: 'user' | 'assistant'; content: string; interrupted?: true; seq: number }>
  readonly lastTurnEndReason: TurnEndReason | null
  readonly tools: Array<{ callId: string; name: string; status: string; summary: string; args: Record<string, unknown>; error: string | null; parentCallId?: string | null; seq: number }>
  readonly pendingAsk: string | null
  readonly pendingApprovals: Array<{ requestId: string; name: string; policy: string; args: Record<string, unknown>; seq: number }>
  readonly plan: { steps: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>; updatedAt: string | null }
  readonly todos: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; provider: string | null; model: string | null }
  readonly cancellation: { reason: string; ts: string } | null
  readonly maintenance: { running: boolean; kind: string | null; lastAt: string | null }
  readonly maintenanceJobs: Array<{
    jobId: string
    agentId: string
    kind: 'checkpoint' | 'compaction'
    status: 'queued' | 'running' | 'done' | 'failed'
    summary: string | null
    error: string | null
    createdAt: string
    startedAt: string | null
    finishedAt: string | null
  }>
  readonly compaction: { count: number; lastSeq: number | null; summary: string | null }
  readonly lineage: { parentSessionId: string | null; forkSeq: number | null }
  readonly children: Array<{ agentId: string; sessionId: string; seq: number }>
  readonly lastSeq: number
}

/**
 * SEC-6：EventStore 的 id 空间还包含运行时/测试用的不透明 id（旧 SessionStore
 * 则只有时间戳格式），因此这里防的是路径注入而不是强约束格式——只允许字母
 * 数字开头的安全字符集，挡住 `../`、分隔符、控制字符等穿越原语。
 */
const EVENT_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function eventPath(historyDir: string, sessionId: string): string {
  if (!EVENT_SESSION_ID_RE.test(sessionId)) throw new Error(`非法会话 ID: ${sessionId}`)
  return join(historyDir, `session_${sessionId}.events.jsonl`)
}

/**
 * P0-6 容错回放：逐行扫描，坏行/序号断裂处截断——不再让一行半写数据把整个
 * 会话锁死。`damaged` 表示截断点之后仍有内容（append 时据此自愈重建）。
 */
function scanRowsTolerant(text: string, sessionId: string): { rows: SessionEventEnvelope[]; damaged: boolean } {
  const rows: SessionEventEnvelope[] = []
  const lines = text.split(/\r?\n/)
  let expected = 1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line === '') continue
    try {
      const row = sessionEventEnvelope.parse(JSON.parse(line) as unknown)
      if (row.seq !== expected) throw new Error(`seq=${row.seq} 应为 ${expected}`)
      rows.push(row)
      expected += 1
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[events] 会话 ${sessionId} 事件文件在第 ${index + 1} 行后截断（${reason}）；后续行将在下次追加时归档为 .corrupt 备份`)
      return { rows, damaged: lines.slice(index).some(candidate => candidate.trim() !== '') }
    }
  }
  return { rows, damaged: false }
}

/** P0-6 自愈追加语义：健康文件走纯 `fs.appendFile`+fsync，坏文件一次性原子重建并备份原件。 */
function serializeRows(rows: ReadonlyArray<SessionEventEnvelope>): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

/** Windows can briefly hold the destination while a concurrent projection
 * read closes its handle. Retry only transient replace failures; all other
 * filesystem errors remain visible to the caller. */
async function replaceEventFile(tmp: string, target: string): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(tmp, target)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)))
    }
  }
  throw last
}

/** Durable event store used by Agent runtime and ACP replay. */
export class SessionEventStore {
  private static readonly appendLocks = new Map<string, Promise<void>>()
  constructor(readonly historyDir: string) {}

  pathFor(sessionId: string): string {
    return eventPath(this.historyDir, sessionId)
  }

  async load(sessionId: string): Promise<SessionEventEnvelope[]> {
    const text = await readFile(this.pathFor(sessionId), 'utf8').catch(() => '')
    return scanRowsTolerant(text, sessionId).rows
  }

  async loadAfter(sessionId: string, afterSeq = 0): Promise<SessionEventEnvelope[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('事件序号必须是非负整数')
    return (await this.load(sessionId)).filter(row => row.seq > afterSeq)
  }

  async append(sessionId: string, ...events: Array<Omit<SessionEventEnvelope, 'seq'>>): Promise<SessionEventEnvelope[]> {
    if (events.length === 0) return []
    const path = this.pathFor(sessionId)
    const previousLock = SessionEventStore.appendLocks.get(path) ?? Promise.resolve()
    let release!: () => void
    const currentLock = new Promise<void>(resolve => { release = resolve })
    SessionEventStore.appendLocks.set(path, currentLock)
    await previousLock
    try {
      await mkdir(this.historyDir, { recursive: true })
      const raw = await readFile(path, 'utf8').catch(() => null)
      const { rows: existing, damaged } = raw === null ? { rows: [] as SessionEventEnvelope[], damaged: false } : scanRowsTolerant(raw, sessionId)
      const next = events.map((event, index) => sessionEventEnvelope.parse({ ...event, seq: existing.length + index + 1 }))
      const chunk = serializeRows(next)
      if (raw !== null && !damaged) {
        // P0-6：健康路径不再整文件重写（大日志下 O(n)/次且断电丢整本），
        // 改为纯追加 + 每批 fsync——半行损坏在下次读取时被容错截断。
        const handle = await open(path, 'a')
        try {
          await handle.writeFile(chunk, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      } else if (raw === null || !damaged) {
        // 新文件：一次性原子写入初始事件。
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        await writeFile(tmp, chunk, 'utf8')
        await replaceEventFile(tmp, path)
      } else {
        // 自愈：原件备份 .corrupt-<时间戳>，以合法前缀 + 新事件原子重建。
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await writeFile(`${path}.corrupt-${stamp}`, raw, 'utf8').catch(() => undefined)
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        await writeFile(tmp, serializeRows(existing) + chunk, 'utf8')
        await replaceEventFile(tmp, path)
      }
      return next
    } finally {
      release()
      if (SessionEventStore.appendLocks.get(path) === currentLock) SessionEventStore.appendLocks.delete(path)
    }
  }

  /** Append a first-party event after validating its discriminated payload. */
  async appendKnown<T extends SessionEventName>(sessionId: string, type: T, payload: SessionEventMap[T], ts = utcTs()): Promise<KnownSessionEventEnvelope<T>> {
    const schema = knownPayloadSchemas[type]
    if (schema !== undefined) schema.parse(payload)
    const [row] = await this.append(sessionId, { ts, type, payload })
    return row as KnownSessionEventEnvelope<T>
  }

  /** Explicit escape hatch for plugin-owned events that are intentionally open. */
  async appendUnknown(sessionId: string, type: string, payload: Record<string, unknown>, ts = utcTs()): Promise<SessionEventEnvelope> {
    const [row] = await this.append(sessionId, { ts, type, payload })
    return row!
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await stat(this.pathFor(sessionId)).catch(() => null)) !== null
  }

  /** Fork an event log at a persisted chat boundary without mutating source. */
  async forkSession(sourceSessionId: string, targetSessionId: string, throughChatIndex?: number): Promise<void> {
    const source = await this.load(sourceSessionId)
    let rows = source
    if (throughChatIndex !== undefined) {
      if (!Number.isInteger(throughChatIndex) || throughChatIndex < 0) throw new Error('分支位置无效')
      let chatIndex = 0
      let cutoff = -1
      // 与投影同口径：被 input/voided 剔除的输入不计入对话边界。
      const voidedSeqs = new Set(source.filter(row => row.type === 'input/voided').map(row => Number(row.payload['seq'] ?? 0)).filter(seq => Number.isInteger(seq) && seq > 0))
      for (const row of source) {
        if (row.type !== 'user/input' && row.type !== 'assistant/message') continue
        if (voidedSeqs.has(row.seq)) continue
        if (chatIndex === throughChatIndex) { cutoff = row.seq; break }
        chatIndex += 1
      }
      if (cutoff < 0) throw new Error('分支位置不存在')
      rows = source.filter(row => row.seq <= cutoff)
    }
    const copied = rows.map(row => ({ ts: row.ts, type: row.type, payload: row.payload }))
    await this.append(targetSessionId, ...copied, { ts: utcTs(), type: 'session/fork', payload: { parentSessionId: sourceSessionId, forkSeq: rows.at(-1)?.seq ?? 0 } })
  }

  async project(sessionId: string): Promise<SessionProjection> {
    const rows = await this.load(sessionId)
    const messages: SessionProjection['messages'] = []
    const tools: SessionProjection['tools'] = []
    const pendingApprovals: SessionProjection['pendingApprovals'] = []
    let plan: SessionProjection['plan'] = { steps: [], updatedAt: null }
    let todos: SessionProjection['todos'] = []
    let usage: SessionProjection['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, provider: null, model: null }
    let lineage: SessionProjection['lineage'] = { parentSessionId: null, forkSeq: null }
    const children: SessionProjection['children'] = []
    let phase: SessionProjection['phase'] = 'idle'
    let lastTurnEndReason: TurnEndReason | null = null
    let currentModel: SessionProjection['currentModel'] = null
    let modelProvenance: SessionProjection['modelProvenance'] = { provider: '', model: '', effort: null, requestId: null }
    let agentConfig: SessionProjection['agentConfig'] = null
    let agentRuntime: SessionProjection['agentRuntime'] = null
    let cancellation: SessionProjection['cancellation'] = null
    let maintenance: SessionProjection['maintenance'] = { running: false, kind: null, lastAt: null }
    const maintenanceJobs: SessionProjection['maintenanceJobs'] = []
    let compaction: SessionProjection['compaction'] = { count: 0, lastSeq: null, summary: null }
    let pendingAsk: string | null = null
    for (const row of rows) {
      const payload = row.payload
      if (row.type === 'agent/runtime' && agentRuntime === null) {
        const capabilities = Array.isArray(payload['capabilities'])
          ? payload['capabilities'].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).map(item => ({
            id: String(item['id'] ?? ''),
            available: item['available'] === true,
            reason: typeof item['reason'] === 'string' ? item['reason'] : null,
            installAction: typeof item['installAction'] === 'string' ? item['installAction'] : null,
          })).filter(item => item.id !== '')
          : []
        agentRuntime = {
          agentId: String(payload['agentId'] ?? ''),
          sessionId: String(payload['sessionId'] ?? sessionId),
          cwd: String(payload['cwd'] ?? ''),
          preset: typeof payload['preset'] === 'object' && payload['preset'] !== null ? payload['preset'] as Record<string, unknown> : {},
          permissionPreset: payload['permissionPreset'] === 'read-only' || payload['permissionPreset'] === 'danger-full-access' ? payload['permissionPreset'] : 'workspace-write',
          capabilities,
          systemPrompt: typeof payload['systemPrompt'] === 'string' ? payload['systemPrompt'] : '',
        }
        if (typeof payload['provider'] === 'string' && payload['provider'] !== '' && typeof payload['model'] === 'string' && payload['model'] !== '') {
          currentModel = { provider: payload['provider'], model: payload['model'], ...(typeof payload['effort'] === 'string' ? { effort: payload['effort'] } : {}) }
          modelProvenance = {
            provider: payload['provider'],
            model: payload['model'],
            effort: typeof payload['effort'] === 'string' ? payload['effort'] : null,
            requestId: null,
          }
        }
      } else if (row.type === 'request/header' || row.type === 'session/model' || row.type === 'model/provenance') {
        const provider = typeof payload['provider'] === 'string' ? payload['provider'] : ''
        const model = typeof payload['model'] === 'string' ? payload['model'] : ''
        if (provider !== '' && model !== '') {
          currentModel = { provider, model, ...(typeof payload['effort'] === 'string' ? { effort: payload['effort'] } : {}) }
          modelProvenance = {
            provider,
            model,
            effort: typeof payload['effort'] === 'string' ? payload['effort'] : modelProvenance.effort,
            requestId: typeof payload['requestId'] === 'string' ? payload['requestId'] : modelProvenance.requestId,
          }
        } else if (row.type === 'session/model' && payload['cleared'] === true) {
          currentModel = null
          modelProvenance = { provider: '', model: '', effort: null, requestId: null }
        }
      } else if (row.type === 'agent/config' && agentConfig === null) {
        const permission = payload['permissionPreset']
        const plugins = payload['plugins']
        agentConfig = {
          agentPreset: payload['agentPreset'] === 'general' ? 'general' : 'studyclaw-learning',
          permissionPreset: permission === 'read-only' || permission === 'danger-full-access' ? permission : 'workspace-write',
          plugins: typeof plugins === 'object' && plugins !== null
            ? Object.fromEntries(Object.entries(plugins).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
            : {},
        }
      } else if (row.type === 'user/input') {
        messages.push({ role: 'user', content: String(payload['content'] ?? ''), seq: row.seq })
      } else if (row.type === 'input/voided') {
        // 追加式日志的“软删除”：失败回合在 turn/error 后补写该事件，把零输出
        // 的用户输入从会话与回放中剔除（重复消息修复，2026-09）。
        const voidedSeq = Number(payload['seq'] ?? 0)
        if (Number.isInteger(voidedSeq) && voidedSeq > 0) {
          const index = messages.findIndex(message => message.role === 'user' && message.seq === voidedSeq)
          if (index >= 0) messages.splice(index, 1)
        }
      } else if (row.type === 'assistant/voided') {
        // A5：与 input/voided 对称——失败重试新开 turn 时，旧 turn 已落盘的
        // 部分 assistant 输出一并剔除（孤儿回复 + 重连序号口径漂移修复）。
        const voidedSeq = Number(payload['seq'] ?? 0)
        if (Number.isInteger(voidedSeq) && voidedSeq > 0) {
          const index = messages.findIndex(message => message.role === 'assistant' && message.seq === voidedSeq)
          if (index >= 0) messages.splice(index, 1)
        }
      } else if (row.type === 'assistant/message') {
        messages.push({ role: 'assistant', content: String(payload['content'] ?? ''), ...(payload['interrupted'] === true ? { interrupted: true as const } : {}), seq: row.seq })
      } else if (row.type === 'tool/result') {
        const callId = String(payload['callId'] ?? '')
        const existing = tools.findIndex(tool => tool.callId !== '' && tool.callId === callId)
        const previousTool = existing >= 0 ? tools[existing] : undefined
        const value = { callId, name: String(payload['name'] ?? previousTool?.name ?? ''), status: String(payload['status'] ?? 'unknown'), summary: String(payload['summary'] ?? ''), args: typeof payload['args'] === 'object' && payload['args'] !== null ? payload['args'] as Record<string, unknown> : previousTool?.args ?? {}, error: typeof payload['error'] === 'string' ? payload['error'] : null, ...(typeof payload['parentCallId'] === 'string' ? { parentCallId: payload['parentCallId'] } : {}), seq: row.seq }
        if (existing >= 0) tools[existing] = value
        else tools.push(value)
        const data = typeof payload['data'] === 'object' && payload['data'] !== null ? payload['data'] as Record<string, unknown> : null
        if (data !== null && payload['name'] === 'plan' && Array.isArray(data['steps'])) {
          plan = { steps: data['steps'].filter((item): item is string | Record<string, unknown> => typeof item === 'string' || (typeof item === 'object' && item !== null)).map((item, index) => typeof item === 'string'
            ? { id: `step-${index + 1}`, text: item, status: 'pending' as const }
            : { id: typeof item['id'] === 'string' ? item['id'] : `step-${index + 1}`, text: String(item['text'] ?? item['title'] ?? ''), status: item['status'] === 'completed' || item['status'] === 'in_progress' ? item['status'] : 'pending' as const }), updatedAt: row.ts }
        }
        if (data !== null && payload['name'] === 'todo' && Array.isArray(data['items'])) {
          todos = data['items'].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).map((item, index) => ({ id: typeof item['id'] === 'string' ? item['id'] : `todo-${index + 1}`, text: String(item['text'] ?? item['title'] ?? ''), status: item['status'] === 'completed' || item['status'] === 'in_progress' ? item['status'] : 'pending' }))
        }
        const resultUsage = data?.['usage']
        if (typeof resultUsage === 'object' && resultUsage !== null) {
          const rowUsage = resultUsage as Record<string, unknown>
          usage = {
            inputTokens: usage.inputTokens + Number(rowUsage['inputTokens'] ?? 0),
            outputTokens: usage.outputTokens + Number(rowUsage['outputTokens'] ?? 0),
            totalTokens: usage.totalTokens + Number(rowUsage['totalTokens'] ?? 0),
            costUsd: usage.costUsd + Number(rowUsage['costUsd'] ?? 0),
            provider: typeof rowUsage['provider'] === 'string' ? rowUsage['provider'] : usage.provider,
            model: typeof rowUsage['model'] === 'string' ? rowUsage['model'] : usage.model,
          }
        }
      } else if (row.type === 'tool/call') {
        const callId = String(payload['callId'] ?? '')
        if (callId !== '' && !tools.some(tool => tool.callId === callId)) tools.push({ callId, name: String(payload['name'] ?? ''), status: 'running', summary: '执行中…', args: typeof payload['args'] === 'object' && payload['args'] !== null ? payload['args'] as Record<string, unknown> : {}, error: null, ...(typeof payload['parentCallId'] === 'string' ? { parentCallId: payload['parentCallId'] } : {}), seq: row.seq })
      } else if (row.type === 'approval/pending') {
        pendingApprovals.push({ requestId: String(payload['requestId'] ?? ''), name: String(payload['name'] ?? ''), policy: String(payload['policy'] ?? ''), args: typeof payload['args'] === 'object' && payload['args'] !== null ? payload['args'] as Record<string, unknown> : {}, seq: row.seq })
      } else if (row.type === 'approval/resolved') {
        const requestId = String(payload['requestId'] ?? '')
        const index = pendingApprovals.findIndex(item => item.requestId === requestId)
        if (index >= 0) pendingApprovals.splice(index, 1)
      } else if (row.type === 'plan/update') {
        const steps = Array.isArray(payload['steps']) ? payload['steps'] : []
        plan = { steps: steps.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).map((item, index) => ({ id: String(item['id'] ?? `step-${index + 1}`), text: String(item['text'] ?? ''), status: item['status'] === 'completed' || item['status'] === 'in_progress' ? item['status'] : 'pending' })), updatedAt: row.ts }
      } else if (row.type === 'todo/update') {
        const items = Array.isArray(payload['items']) ? payload['items'] : []
        todos = items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).map((item, index) => ({ id: String(item['id'] ?? `todo-${index + 1}`), text: String(item['text'] ?? item['title'] ?? ''), status: item['status'] === 'completed' || item['status'] === 'in_progress' ? item['status'] : 'pending' }))
      } else if (row.type === 'usage') {
        usage = {
          inputTokens: usage.inputTokens + Number(payload['inputTokens'] ?? 0),
          outputTokens: usage.outputTokens + Number(payload['outputTokens'] ?? 0),
          totalTokens: usage.totalTokens + Number(payload['totalTokens'] ?? Number(payload['inputTokens'] ?? 0) + Number(payload['outputTokens'] ?? 0)),
          costUsd: usage.costUsd + Number(payload['costUsd'] ?? 0),
          provider: typeof payload['provider'] === 'string' ? payload['provider'] : usage.provider,
          model: typeof payload['model'] === 'string' ? payload['model'] : usage.model,
        }
      } else if (row.type === 'inbox/queued') {
        if (phase === 'idle') phase = 'queued'
      } else if (row.type === 'inbox/dequeued') {
        phase = 'running'
      } else if (row.type === 'inbox/dropped') {
        if (phase === 'queued') phase = 'idle'
      } else if (row.type === 'maintenance/start') {
        maintenance = { running: true, kind: typeof payload['kind'] === 'string' ? payload['kind'] : null, lastAt: row.ts }
        const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : ''
        if (jobId !== '') {
          const index = maintenanceJobs.findIndex(job => job.jobId === jobId)
          const previous = index >= 0 ? maintenanceJobs[index]! : {
            jobId,
            agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : '',
            kind: payload['kind'] === 'compaction' ? 'compaction' as const : 'checkpoint' as const,
            status: 'queued' as const,
            summary: typeof payload['summary'] === 'string' ? payload['summary'] : null,
            error: null,
            createdAt: row.ts,
            startedAt: null,
            finishedAt: null,
          }
          const next = { ...previous, status: 'running' as const, startedAt: row.ts }
          if (index >= 0) maintenanceJobs[index] = next
          else maintenanceJobs.push(next)
        }
      } else if (row.type === 'maintenance/end' || row.type === 'maintenance/error') {
        maintenance = { running: false, kind: typeof payload['kind'] === 'string' ? payload['kind'] : maintenance.kind, lastAt: row.ts }
        const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : ''
        if (jobId !== '') {
          const index = maintenanceJobs.findIndex(job => job.jobId === jobId)
          const previous = index >= 0 ? maintenanceJobs[index]! : {
            jobId,
            agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : '',
            kind: payload['kind'] === 'compaction' ? 'compaction' as const : 'checkpoint' as const,
            status: 'queued' as const,
            summary: typeof payload['summary'] === 'string' ? payload['summary'] : null,
            error: null,
            createdAt: row.ts,
            startedAt: null,
            finishedAt: null,
          }
          const next = {
            ...previous,
            status: row.type === 'maintenance/error' ? 'failed' as const : 'done' as const,
            error: row.type === 'maintenance/error' ? String(payload['message'] ?? '维护任务失败') : null,
            finishedAt: row.ts,
          }
          if (index >= 0) maintenanceJobs[index] = next
          else maintenanceJobs.push(next)
        }
      } else if (row.type === 'maintenance/queued') {
        const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : ''
        if (jobId !== '' && !maintenanceJobs.some(job => job.jobId === jobId)) {
          maintenanceJobs.push({
            jobId,
            agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : '',
            kind: payload['kind'] === 'compaction' ? 'compaction' : 'checkpoint',
            status: 'queued',
            summary: typeof payload['summary'] === 'string' ? payload['summary'] : null,
            error: null,
            createdAt: row.ts,
            startedAt: null,
            finishedAt: null,
          })
        }
      } else if (row.type === 'compaction/applied') {
        compaction = { count: compaction.count + 1, lastSeq: row.seq, summary: typeof payload['summary'] === 'string' ? payload['summary'] : null }
      } else if (row.type === 'session/fork') {
        lineage = { parentSessionId: typeof payload['parentSessionId'] === 'string' ? payload['parentSessionId'] : null, forkSeq: typeof payload['forkSeq'] === 'number' ? payload['forkSeq'] : null }
      } else if (row.type === 'agent/child') {
        const agentId = typeof payload['childAgentId'] === 'string' ? payload['childAgentId'] : ''
        const sessionId = typeof payload['childSessionId'] === 'string' ? payload['childSessionId'] : ''
        if (agentId !== '' && sessionId !== '' && !children.some(child => child.agentId === agentId)) children.push({ agentId, sessionId, seq: row.seq })
      } else if (row.type === 'session/rename' || row.type === 'session/title') {
        // SessionStore derives the visible title from these append-only events.
        continue
      } else if (row.type === 'ask/pending') {
        pendingAsk = String(payload['question'] ?? '')
        phase = 'waiting'
      } else if (row.type === 'ask/answered') {
        pendingAsk = null
      } else if (row.type === 'turn/start') {
        phase = 'running'
      } else if (row.type === 'turn/end') {
        const reason = payload['reason']
        const parsedReason = turnEndReasonSchema.safeParse(reason)
        if (parsedReason.success) lastTurnEndReason = parsedReason.data as TurnEndReason
        if (typeof reason === 'object' && reason !== null && (reason as Record<string, unknown>)['kind'] === 'blocked') phase = 'waiting'
        else if (typeof reason === 'object' && reason !== null && (reason as Record<string, unknown>)['kind'] === 'aborted') phase = 'cancelled'
        else phase = 'idle'
      } else if (row.type === 'turn/cancelled') {
        phase = 'cancelled'
        cancellation = { reason: String(payload['reason'] ?? 'cancelled'), ts: row.ts }
      } else if (row.type === 'session/disposed') {
        phase = 'disposed'
      }
    }
    return { sessionId, phase, currentModel, modelProvenance, agentConfig, agentRuntime, messages, lastTurnEndReason, tools, pendingAsk, pendingApprovals, plan, todos, usage, cancellation, maintenance, maintenanceJobs, compaction, lineage, children, lastSeq: rows.at(-1)?.seq ?? 0 }
  }
}
