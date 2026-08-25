/**
 * TutorSession: one course's chat orchestrator — context assembly, tool
 * loop with mode-filtered schemas, streaming split (think/token/sync),
 * append-only persistence, and sync application. Ported from Python
 * `session.py::TutorSession`.
 * @module @studyclaw/session/src/session
 */

import { stat } from 'node:fs/promises'
import { ContextAssembler } from './context.ts'
import { SyncApplier } from './applier.ts'
import { SessionStore, SessionError, utcTs } from './store.ts'
import { SessionEventStore } from './events.ts'
import { ToolStreamSplitter, extractSync, type StreamEvent } from './splitter.ts'
import { chatLine, askLine, toolLine, type ChatLine, type HistoryLine, type LearningMode } from './models.ts'
import { LOOP_LIMIT_NAME, ToolResult, type ToolActions, type ToolContext, type ToolRegistry } from '@studyclaw/tools'

export const DEFAULT_TOOL_LOOP_LIMIT = 8

function sessionIdFor(date: Date): string {
  const compact = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${compact.slice(0, 8)}-${compact.slice(8)}`
}

/** One model-initiated tool call (parsed arguments). */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly parentCallId?: string | null
}

/**
 * The LLM client seam for the tool loop. Emits text deltas (raw, may carry
 * `<think>`/sync markers) and finally one `toolCalls` batch per round.
 */
export interface ToolLlmClient {
  request(
    system: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): AsyncGenerator<{ kind: 'text'; delta: string } | { kind: 'toolCalls'; calls: ToolCall[] }>
}

/** Chat-turn events the service layer maps to SSE frames. */
export type ChatEvent =
  | { kind: 'thinking'; delta: string }
  | { kind: 'token'; delta: string }
  | { kind: 'tool-start'; payload: { callId: string; name: string; args: Record<string, unknown>; parentCallId?: string | null } }
  | { kind: 'tool'; payload: Record<string, unknown> }
  | { kind: 'ask'; question: string }
  | { kind: 'sync'; payload: Record<string, unknown> }

/** Clip public args for audit/events (write_note/ask keep body out). */
export function publicToolArgs(name: string, args: Record<string, unknown>, maxString = 120): Record<string, unknown> {
  if (name === 'write_note') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (key === 'content') out['contentLength'] = String(value ?? '').length
      else if (key === 'conceptId' || key === 'chapterId') out[key] = value
    }
    return out
  }
  if (name === 'ask_user_question') {
    return { questionLength: String(args['question'] ?? '').length }
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > maxString) out[key] = value.slice(0, maxString) + '…'
    else out[key] = value
  }
  return out
}

/**
 * One session's orchestration over its course. Instantiate with
 * `new: true` to create the session file, or with an existing `sessionId`
 * (or neither → latest is resumed, creating when absent). Call `init()`
 * once before first use to resolve the real session id.
 */
export class TutorSession {
  readonly store: SessionStore
  sessionId: string
  private readonly forceNew: boolean
  private readonly resumed: boolean
  mode: LearningMode
  private readonly conceptId: string | null
  private readonly assembler: ContextAssembler
  private readonly applier: SyncApplier
  private readonly nowFactory: () => Date
  private readonly toolRegistry: ToolRegistry | null
  private readonly toolActions: ToolActions | undefined
  private readonly approval: ((request: { name: string; policy: string; args: Record<string, unknown> }) => Promise<'allow' | 'deny'>) | undefined
  private readonly toolClientFactory: (() => ToolLlmClient) | null
  private readonly toolLoopLimit: number
  private readonly persistLegacy: boolean
  private readonly eventStore: SessionEventStore | null
  private readonly providers: ToolContext['providers'] | undefined
  /** Tool preset is independent from the visible learning mode. */
  private readonly toolMode: string | null

  constructor(
    readonly courseDir: string,
    readonly workspaceRoot: string,
    options: {
      sessionId?: string | null
      new?: boolean
      mode?: LearningMode
      conceptId?: string | null
      assembler?: ContextAssembler
      applier?: SyncApplier
      nowFactory?: () => Date
      toolRegistry?: ToolRegistry | null
      toolActions?: ToolActions
      approval?: (request: { name: string; policy: string; args: Record<string, unknown> }) => Promise<'allow' | 'deny'>
      toolClientFactory?: (() => ToolLlmClient) | null
      toolLoopLimit?: number
      persistLegacy?: boolean
      eventStore?: SessionEventStore
      providers?: ToolContext['providers']
      /** Agent preset sections are prepended to the course prompt. */
      systemPrompt?: string
      /** Optional preset-level tool mode (for example `general`). */
      toolMode?: string
    } = {},
  ) {
    this.store = new SessionStore(courseDir + '/history')
    this.forceNew = options.new === true
    this.resumed = options.sessionId !== undefined && options.sessionId !== null
    this.sessionId = options.sessionId ?? ''
    this.mode = options.mode ?? 'socratic'
    this.conceptId = options.conceptId ?? null
    this.assembler = options.assembler ?? new ContextAssembler(courseDir, workspaceRoot)
    this.applier = options.applier ?? new SyncApplier(courseDir, workspaceRoot)
    this.nowFactory = options.nowFactory ?? (() => new Date())
    this.toolRegistry = options.toolRegistry ?? null
    this.toolActions = options.toolActions
    this.approval = options.approval
    this.toolClientFactory = options.toolClientFactory ?? null
    this.toolLoopLimit = Math.max(1, options.toolLoopLimit ?? DEFAULT_TOOL_LOOP_LIMIT)
    this.persistLegacy = options.persistLegacy !== false
    this.eventStore = options.eventStore ?? null
    this.providers = options.providers
    this.toolMode = options.toolMode?.trim() || null
    this.systemPrompt = options.systemPrompt?.trim() ?? ''
  }

  private readonly systemPrompt: string

  /** Resolve the real session id (verify an explicit id, resume latest, or create). */
  async init(): Promise<void> {
    if (this.sessionId !== '') {
      const path = this.store.pathFor(this.sessionId)
      if ((await stat(path).catch(() => null)) === null && (this.eventStore === null || !(await this.eventStore.exists(this.sessionId)))) {
        throw new SessionError(`会话不存在: ${this.sessionId}`)
      }
      return
    }
    if (!this.persistLegacy && this.eventStore !== null) {
      if (!this.forceNew) {
        const latest = await this.store.latestSessionId()
        if (latest !== null) {
          this.sessionId = latest
          return
        }
      }
      const base = this.nowFactory()
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const candidate = sessionIdFor(new Date(base.getTime() + attempt * 1000))
        if (await this.eventStore.exists(candidate) || await stat(this.store.pathFor(candidate)).then(() => true).catch(() => false)) continue
        this.sessionId = candidate
        await this.eventStore.append(this.sessionId, { ts: utcTs(base), type: 'session/create', payload: { mode: this.mode } })
        return
      }
      throw new SessionError('无法创建事件会话：时间戳冲突')
    }
    if (!this.forceNew) {
      const latest = await this.store.latestSessionId()
      if (latest !== null) {
        this.sessionId = latest
        return
      }
    }
    const created = await this.store.newSession(this.mode, null, this.nowFactory())
    this.sessionId = created.sessionId
  }

  /** True when the session was resumed (existing) rather than created. */
  get wasResumed(): boolean {
    return this.resumed
  }

  async title(): Promise<string> {
    const meta = await this.store.readMeta(this.sessionId)
    return meta?.title && meta.title !== '' ? meta.title : '（未命名会话）'
  }

  async history(): Promise<ChatLine[]> {
    if (!this.persistLegacy && this.eventStore !== null && await this.eventStore.exists(this.sessionId)) {
      const projection = await this.eventStore.project(this.sessionId)
      return projection.messages.map(message => ({ type: 'chat' as const, ts: utcTs(), role: message.role === 'user' ? 'user' as const : 'agent' as const, content: message.content }))
    }
    return this.store.loadChat(this.sessionId)
  }

  /** The last `ask` row's question when it is still pending (M-C flow). */
  private async pendingAsk(): Promise<string | null> {
    if (!this.persistLegacy && this.eventStore !== null && await this.eventStore.exists(this.sessionId)) return (await this.eventStore.project(this.sessionId)).pendingAsk
    let last: Record<string, unknown> | null = null
    for (const row of await this.store.load(this.sessionId)) {
      if (row['type'] === 'ask') last = row
    }
    if (last !== null && last['status'] === 'pending') return String(last['question'] ?? '')
    return null
  }

  /**
   * One turn's structured event stream (SSE data source). Persists the turn
   * (user/chat + tool/ask/sync audit lines) before yielding the final sync.
   */
  async *chatEvents(
    userText: string,
    mode: LearningMode | null = null,
    fileContext: string | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    if (mode !== null) this.mode = mode
    const text = userText.trim()
    if (text === '') throw new SessionError('消息为空')
    const now = this.nowFactory()
    if (this.persistLegacy) await this.store.fillDefaultTitle(this.sessionId, text)

    const rendered = await this.assembler.renderTurn(this.mode, text, this.conceptId)
    const systemPrompt = this.systemPrompt === '' ? rendered.system : `${this.systemPrompt}\n\n${rendered.system}`
    let userPrompt = rendered.user
    if (fileContext !== null) {
      userPrompt = `${userPrompt}\n\n[用户引用的课程文件]\n${fileContext}\n请只把这些文件作为本轮回答的补充依据。`
    }
    // Keep the exact model-visible prompt reconstructable from the event log.
    // Raw user/input remains separate so projections can display the concise
    // transcript without exposing assembled course context by default.
    if (this.eventStore !== null && !this.persistLegacy) {
      await this.eventStore.append(this.sessionId, {
        ts: utcTs(now),
        type: 'prompt/assembled',
        payload: { system: systemPrompt, user: userPrompt, mode: this.mode },
      })
    }
    const priorMessages = !this.persistLegacy && this.eventStore !== null && await this.eventStore.exists(this.sessionId)
      ? (await this.eventStore.project(this.sessionId)).messages.map(line => ({ role: line.role, content: line.content }))
      : await this.store.loadChat(this.sessionId)
    const messages = priorMessages.map(line => ({
      role: line.role === 'agent' ? 'assistant' : line.role,
      content: line.content,
    }))
    const answeredAsk = await this.pendingAsk()
    if (answeredAsk !== null) {
      messages.push({ role: 'assistant', content: `[你上一轮向学生提出的提问] ${answeredAsk}` })
      // Event-log sessions do not write legacy `ask` rows. Persist the
      // answer boundary before requesting the next model step so a crash or
      // resume cannot show the same question as pending forever.
      if (!this.persistLegacy && this.eventStore !== null) {
        await this.eventStore.append(this.sessionId, {
          ts: utcTs(now),
          type: 'ask/answered',
          payload: { question: answeredAsk, answer: text },
        })
      }
    }

    const askQuestions: string[] = []
    const collected: string[] = []
    const rawParts: string[] = []
    const toolLines: Array<{ type: 'tool'; ts: string; name: string; status: string; args: Record<string, unknown>; summary: string; error: string | null; duration_ms: number }> = []
    const emitSplit = function* (events: StreamEvent[]): Generator<ChatEvent> {
      for (const event of events) {
        if (event.kind === 'text') { collected.push(event.delta); yield { kind: 'token', delta: event.delta } }
        else if (event.kind === 'think') yield { kind: 'thinking', delta: event.delta }
      }
    }

    try {
      if (this.toolRegistry !== null && this.toolClientFactory !== null) {
        yield* this.toolStream(
          this.toolClientFactory(),
          systemPrompt,
          messages,
          userPrompt,
          collected,
          rawParts,
          toolLines,
          askQuestions,
          now,
          emitSplit,
          signal,
        )
      } else {
        const splitter = new ToolStreamSplitter()
        const client = this.toolClientFactory!()
        for await (const event of client.request(systemPrompt, [...messages, { role: 'user', content: userPrompt }], null, signal)) {
          if (event.kind === 'text') {
            rawParts.push(event.delta)
            yield* emitSplit(splitter.feed(event.delta))
          }
        }
        yield* emitSplit(splitter.flush())
      }
      const [, syncPayload] = extractSync(rawParts.join(''))
      const [visible] = extractSync(collected.join(''))
      // Persist the turn (user + tools + agent/ask lines + sync audit).
      const pending: Array<Record<string, unknown>> = [
        chatLine.parse({ type: 'chat', ts: utcTs(now), role: 'user', content: text }),
        ...toolLines,
      ]
      if (answeredAsk !== null) {
        pending.push(askLine.parse({ type: 'ask', ts: utcTs(now), question: answeredAsk, status: 'answered', answer: text }))
      }
      if (askQuestions.length > 0) {
        for (const question of askQuestions) {
          pending.push(askLine.parse({ type: 'ask', ts: utcTs(now), question, status: 'pending' }))
        }
      } else if (visible.trim() !== '') {
        pending.push(chatLine.parse({ type: 'chat', ts: utcTs(now), role: 'agent', content: visible, mode: this.mode }))
      }
      if (syncPayload !== null) {
        const syncLines = await this.applier.apply(syncPayload, now)
        for (const line of syncLines) pending.push(line as unknown as Record<string, unknown>)
      }
      if (this.persistLegacy) await this.store.append(this.sessionId, ...(pending as unknown as HistoryLine[]))
      if (syncPayload !== null) {
        yield { kind: 'sync', payload: syncPayload as unknown as Record<string, unknown> }
      }
    } catch (error) {
      // Error-path audit fallback: the user line and any executed tool lines
      // persist even when the model call failed (no broken audit chain).
      const [visibleErr] = extractSync(collected.join(''))
      const rows: Array<Record<string, unknown>> = [
        chatLine.parse({ type: 'chat', ts: utcTs(now), role: 'user', content: text }),
        ...toolLines,
      ]
      if (visibleErr.trim() !== '') {
        rows.push(chatLine.parse({ type: 'chat', ts: utcTs(now), role: 'agent', content: visibleErr, mode: this.mode }))
      }
      if (this.persistLegacy) await this.store.append(this.sessionId, ...(rows as unknown as HistoryLine[]))
      throw error
    }
  }

  private async *toolStream(
    client: ToolLlmClient,
    system: string,
    messages: Array<Record<string, unknown>>,
    userPrompt: string,
    collected: string[],
    rawParts: string[],
    toolLines: Array<{ type: 'tool'; ts: string; name: string; status: string; args: Record<string, unknown>; summary: string; error: string | null; duration_ms: number }>,
    askQuestions: string[],
    now: Date,
    emitSplit: (events: StreamEvent[]) => Generator<ChatEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const splitter = new ToolStreamSplitter()
    let roundMessages: Array<Record<string, unknown>> = [...messages, { role: 'user', content: userPrompt }]
    let steps = 0
    while (true) {
      if (signal?.aborted) return
      if (steps >= this.toolLoopLimit) {
        const note = `\n\n（工具调用步数已达上限 ${this.toolLoopLimit}，已停止工具循环）`
        collected.push(note)
        yield { kind: 'token', delta: note }
        yield {
          kind: 'tool',
          payload: {
            name: LOOP_LIMIT_NAME,
            status: 'rejected',
            args: {},
            summary: `工具调用步数超过上限 ${this.toolLoopLimit}，已终止本轮工具循环`,
            error: 'TOOL_LOOP_LIMIT',
            durationMs: 0,
          },
        }
        return
      }
      steps += 1
      const schemas = this.toolRegistry!.schemasForMode(this.toolMode ?? this.mode)
      let calls: ToolCall[] = []
      for await (const event of client.request(system, roundMessages, schemas, signal)) {
        if (signal?.aborted) return
        if (event.kind === 'text') {
          rawParts.push(event.delta)
          yield* emitSplit(splitter.feed(event.delta))
        } else if (event.kind === 'toolCalls') {
          calls = event.calls
        }
      }
      yield* emitSplit(splitter.flush())
      if (calls.length === 0) return

      const assistantToolMsg: Record<string, unknown> = { role: 'assistant', content: null, tool_calls: [] as unknown[] }
      const toolMessages: Array<Record<string, unknown>> = []
      const record = (call: ToolCall, result: ToolResult): void => {
        toolLines.push(toolLine.parse({
          type: 'tool',
          ts: utcTs(now),
          name: call.name,
          status: result.status,
          args: publicToolArgs(call.name, call.arguments),
          summary: result.summary,
          error: result.error,
          duration_ms: Math.round(result.durationMs * 10) / 10,
        }))
        ;(assistantToolMsg['tool_calls'] as unknown[]).push({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: result.toToolMessage() })
      }

      for (const call of calls) {
        yield { kind: 'tool-start', payload: { callId: call.id, name: call.name, args: publicToolArgs(call.name, call.arguments), ...(call.parentCallId === undefined ? {} : { parentCallId: call.parentCallId }) } }
      }
      const toolContext = {
        courseDir: this.courseDir,
        workspaceRoot: this.workspaceRoot,
        sessionId: this.sessionId,
        ...(signal === undefined ? {} : { signal }),
        ...(this.providers === undefined ? {} : { providers: this.providers }),
        ...(this.toolActions === undefined ? {} : { actions: this.toolActions }),
        ...(this.approval === undefined ? {} : { approval: this.approval }),
      }
      // DSH barrier semantics live in ToolRegistry so Agent, TutorSession,
      // ACP and future presets cannot accidentally implement different loops.
      const results = await this.toolRegistry!.executeBatch(
        calls.map(call => ({ callId: call.id, name: call.name, args: call.arguments, ...(call.parentCallId === undefined ? {} : { parentCallId: call.parentCallId }) })),
        toolContext,
      )
      for (const item of results) {
        const call = calls.find(candidate => candidate.id === item.call.callId) ?? calls[results.indexOf(item)]!
        const result = item.result
        record(call, result)
        yield { kind: 'tool', payload: result.toEvent(call.name, publicToolArgs(call.name, call.arguments), call.id, call.parentCallId) }
        if (result.status === 'success' && result.data['ask'] === true && typeof result.data['question'] === 'string') {
          const question = String(result.data['question'])
          askQuestions.push(question)
          yield { kind: 'ask', question }
          return
        }
      }
      roundMessages = [...roundMessages, assistantToolMsg, ...toolMessages]
    }
  }
}

export { SessionError }
