/**
 * DSH-style Agent runtime for StudyClaw.
 *
 * The runtime owns lifecycle, queueing, cancellation, durable event emission,
 * and replay projection. Domain behavior is supplied by a runner so learning,
 * generic tools, ACP, CLI, and Web all share the same orchestration contract.
 * @module @studyclaw/agent
 */

import { SessionEventStore, utcTs, type SessionEventEnvelope, type SessionProjection, type TurnEndReason } from '@studyclaw/session'
import {
  createAgentRuntimeState,
  type AgentCapability,
  type AgentModelSelection,
  type AgentPreset,
  type AgentRuntimeState,
  type AgentScope,
  type AgentPromptContext,
  SystemPromptRegistry,
} from './runtime.ts'

export {
  SystemPromptRegistry,
  createAgentRuntimeState,
  interpolatePrompt,
} from './runtime.ts'
export type {
  AgentCapability,
  AgentModelSelection,
  AgentPreset,
  AgentPromptContext,
  AgentRuntimeState,
  AgentScope,
  PromptSection,
} from './runtime.ts'

export type AgentPhase = 'idle' | 'queued' | 'running' | 'waiting' | 'cancelled' | 'disposed'

export interface AgentTurnInput {
  readonly content: string
  readonly mode?: string
  readonly metadata?: Record<string, unknown>
}

/** DSH-style durable inbox surface shared by Host, ACP, CLI and Web. */
export interface AgentInbox {
  readonly nextTurn: readonly AgentTurnInput[]
  readonly nextStep: readonly AgentTurnInput[]
  readonly hasPending: boolean
  append(target: InboxTarget, input: AgentTurnInput): AgentTurnHandle
  prepend(target: InboxTarget, input: AgentTurnInput): AgentTurnHandle
  replace(turnId: string, input: AgentTurnInput): boolean
  remove(turnId: string): boolean
  clear(): void
}

export type InboxTarget = 'next-turn' | 'next-step'
export type AgentCancelCause = 'user' | 'system' | 'disposed' | 'error' | 'parent' | {
  readonly kind: 'user' | 'system' | 'disposed' | 'error' | 'parent' | 'legacy'
  readonly reason?: string
}

export interface AgentRunnerContext {
  readonly agentId: string
  readonly sessionId: string
  readonly signal: AbortSignal
  /** Immutable runtime facts and the model snapshot for this turn. */
  readonly runtime: AgentRuntimeState
  readonly cwd: string
  readonly capabilities: readonly AgentCapability[]
  readonly scope: AgentScope
  readonly preset: AgentPreset
  readonly modelSelection: AgentModelSelection | null
  /** Messages inserted for the next step/turn by a steering client. */
  readonly inbox: {
    readonly nextTurn: readonly AgentTurnInput[]
    readonly nextStep: readonly AgentTurnInput[]
    /** Context injected by a tool/plugin and parked until the next step. */
    readonly injected: readonly AgentTurnInput[]
    drain(target: InboxTarget): AgentTurnInput[]
  }
}

export interface AgentRunnerEvent {
  readonly type: string
  readonly payload?: Record<string, unknown>
}

export interface AgentToolCall {
  readonly callId: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly mode?: 'parallel' | 'exclusive'
}

export interface AgentToolExecutor {
  execute(call: AgentToolCall, signal: AbortSignal): Promise<Record<string, unknown>>
}

export type AgentRunner = (input: AgentTurnInput, context: AgentRunnerContext) => AsyncGenerator<AgentRunnerEvent>

export interface AgentOptions {
  readonly agentId: string
  readonly sessionId: string
  /** Durable parent relation for child-agent/workflow trees. */
  readonly parentAgentId?: string
  readonly events: SessionEventStore
  readonly runner: AgentRunner
  /** Explicit DSH runtime facts. Defaults are derived only for legacy callers. */
  readonly cwd?: string
  readonly capabilities?: readonly AgentCapability[]
  readonly preset?: AgentPreset
  readonly permissionPreset?: AgentRuntimeState['permissionPreset']
  readonly systemPrompt?: string
  readonly promptRegistry?: SystemPromptRegistry
  readonly modelSelection?: AgentModelSelection | null
  readonly workspaceRoot?: string
  readonly courseId?: string
  readonly tools?: AgentToolExecutor
  /** Optional transient request retry hook owned by the provider/Host. */
  readonly retry?: (error: unknown, attempt: number, signal: AbortSignal) => Promise<boolean>
  readonly retryDelayMs?: number
}

export interface AgentStatus {
  readonly agentId: string
  readonly sessionId: string
  readonly parentAgentId: string | null
  readonly phase: AgentPhase
  readonly queued: number
  readonly activeTurnId: string | null
  readonly cwd: string
  readonly capabilities: readonly AgentCapability[]
  readonly modelSelection: AgentModelSelection | null
  readonly preset: string
}

export type ApprovalDecision = 'allow' | 'deny' | 'cancel' | 'timeout'

export interface ApprovalRequest {
  readonly id: string
  readonly agentId: string
  readonly sessionId: string
  readonly name: string
  readonly policy: string
  readonly args: Record<string, unknown>
  readonly createdAt: string
  readonly expiresAt: string
  readonly status: 'pending' | ApprovalDecision
}

interface PendingApproval extends ApprovalRequest {
  readonly resolve: (decision: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

/** Host-neutral approval broker shared by Web, CLI and ACP adapters. */
export class ApprovalQueue {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly resolvedListeners = new Set<(request: ApprovalRequest, decision: ApprovalDecision) => void | Promise<void>>()

  /** Subscribe to every terminal decision, including timeout. */
  onResolved(listener: (request: ApprovalRequest, decision: ApprovalDecision) => void | Promise<void>): () => void {
    this.resolvedListeners.add(listener)
    return () => this.resolvedListeners.delete(listener)
  }

  request(input: {
    agentId: string
    sessionId: string
    name: string
    policy: string
    args: Record<string, unknown>
    timeoutMs?: number
  }): { request: ApprovalRequest; decision: Promise<ApprovalDecision> } {
    const timeoutMs = Math.max(1, input.timeoutMs ?? 5 * 60_000)
    const approvalId = id('approval')
    const createdAt = new Date()
    const request = {
      id: approvalId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      policy: input.policy,
      args: input.args,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
      status: 'pending' as const,
    }
    let resolvePromise!: (decision: ApprovalDecision) => void
    const decision = new Promise<ApprovalDecision>(resolve => { resolvePromise = resolve })
    const pending: PendingApproval = { ...request, resolve: resolvePromise, timer: setTimeout(() => this.resolve(approvalId, 'timeout'), timeoutMs) }
    this.pending.set(approvalId, pending)
    return { request, decision }
  }

  /**
   * Rehydrate an unresolved request from the durable session event log.
   * Restored requests intentionally keep a live decision promise so a caller
   * that reconnects to the same Agent can resolve it; duplicate restores are
   * idempotent.
   */
  restore(input: Omit<ApprovalRequest, 'status'> & { status?: 'pending' }): ApprovalRequest {
    const existing = this.pending.get(input.id)
    if (existing !== undefined) {
      const { resolve: _resolve, timer: _timer, ...request } = existing
      return request
    }
    const createdAt = new Date(input.createdAt)
    const expiresAt = new Date(input.expiresAt)
    const remaining = Math.max(0, expiresAt.getTime() - Date.now())
    let resolvePromise!: (decision: ApprovalDecision) => void
    const decision = new Promise<ApprovalDecision>(resolve => { resolvePromise = resolve })
    const request: ApprovalRequest = {
      id: input.id,
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      policy: input.policy,
      args: input.args,
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString(),
      expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + remaining).toISOString() : expiresAt.toISOString(),
      status: 'pending',
    }
    const pending: PendingApproval = {
      ...request,
      resolve: resolvePromise,
      timer: setTimeout(() => this.resolve(request.id, 'timeout'), remaining),
    }
    this.pending.set(request.id, pending)
    // Keep the promise owned by the queue. A restored request has no old turn
    // to await, but resolving it must still release the timer and map entry.
    void decision
    return request
  }

  list(agentId?: string): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter(item => agentId === undefined || item.agentId === agentId)
      .map(({ resolve: _resolve, timer: _timer, ...item }) => item)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  resolve(requestId: string, decision: ApprovalDecision): ApprovalRequest {
    const item = this.pending.get(requestId)
    if (item === undefined) throw new Error(`审批请求不存在: ${requestId}`)
    clearTimeout(item.timer)
    this.pending.delete(requestId)
    item.resolve(decision)
    const result = { ...item, status: decision }
    for (const listener of this.resolvedListeners) void Promise.resolve(listener(result, decision)).catch(() => undefined)
    return result
  }

  cancelForAgent(agentId: string): void {
    for (const item of [...this.pending.values()]) {
      if (item.agentId === agentId) this.resolve(item.id, 'cancel')
    }
  }
}

export interface AgentTurnHandle {
  readonly turnId: string
  readonly events: AsyncIterable<AgentEvent>
}

export interface AgentEvent extends AgentRunnerEvent {
  readonly agentId: string
  readonly sessionId: string
  readonly turnId: string
  readonly seq?: number
}

interface QueueEntry {
  readonly turnId: string
  input: AgentTurnInput
  readonly target: InboxTarget
  readonly queue: AsyncEventQueue<AgentEvent>
  /** A dequeued turn recovered after a Host restart already has its user and
   * turn boundary in the event log; replay it without duplicating those rows. */
  readonly recovered: boolean
  /** Injected context is durable but must not open a turn by itself. */
  readonly contextOnly?: boolean
  /** Queue persistence completes before the driver can consume the turn. */
  readonly persisted: Promise<void>
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private readonly rejecters: Array<(error: unknown) => void> = []
  private closed = false
  private failure: unknown = null

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      // Keep resolve/reject waiters paired. Without removing the matching
      // rejecter, a later close(error) can reject an already-resolved read and
      // leave the active consumer waiting forever.
      this.rejecters.shift()
      waiter({ done: false, value })
    }
    else this.values.push(value)
  }

  close(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    this.failure = error ?? null
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (this.failure !== null) {
        const reject = this.rejecters.shift()!
        reject(this.failure)
        this.failure = null
      } else waiter({ done: true, value: undefined as never })
    }
    this.rejecters.splice(0)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed) {
      if (this.failure !== null) {
        const failure = this.failure
        this.failure = null
        return Promise.reject(failure)
      }
      return Promise.resolve({ done: true, value: undefined as never })
    }
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve)
      this.rejecters.push(reject)
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> { return this }
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function asPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload === undefined ? {} : payload
}

type TurnAbortReason = Extract<TurnEndReason, { kind: 'aborted' }>['reason']

function normalizeAbortReason(value: unknown): TurnAbortReason {
  if (typeof value === 'object' && value !== null) {
    const kind = (value as Record<string, unknown>)['kind']
    if (kind === 'user' || kind === 'system' || kind === 'disposed' || kind === 'error' || kind === 'parent' || kind === 'legacy') {
      const detail = (value as Record<string, unknown>)['reason']
      return typeof detail === 'string' && detail.length > 0 ? { kind, reason: detail } : { kind }
    }
  }
  if (value === 'system' || value === 'disposed' || value === 'error' || value === 'parent') return { kind: value }
  if (value === 'user' || value === undefined || value === null) return { kind: 'user' }
  return { kind: 'legacy', reason: String(value) }
}

/** One live Agent with DSH-style queue and cancellation semantics. */
export class Agent {
  private readonly pending: QueueEntry[] = []
  private readonly nextStep: QueueEntry[] = []
  private readonly injected: QueueEntry[] = []
  private activeInjected: QueueEntry[] = []
  private active: { entry: QueueEntry; controller: AbortController } | null = null
  private phase: AgentPhase = 'idle'
  private idleWaiters: Array<() => void> = []
  private disposed = false
  private wakeRequested = false
  private activityDone: Promise<void> = Promise.resolve()

  /** PERF-9：waitForActivity 的宏任务退让周期。 */
  private static readonly ACTIVITY_TICK_MS = 50
  private activityResolve: (() => void) | null = null
  private maintenanceController: AbortController | null = null
  private restored = false
  private readonly completedTurnIds = new Set<string>()
  /** Immutable scope/preset/capability snapshot owned by this live Agent. */
  readonly runtime: AgentRuntimeState
  private modelSelection: AgentModelSelection | null
  private readonly runtimePersisted: Promise<void>
  /** DSH-compatible queue mutation API. */
  readonly inbox: AgentInbox

  constructor(readonly options: AgentOptions) {
    this.runtime = createAgentRuntimeState({
      agentId: options.agentId,
      sessionId: options.sessionId,
      cwd: options.cwd ?? options.events.historyDir,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      ...(options.permissionPreset === undefined ? {} : { permissionPreset: options.permissionPreset }),
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      ...(options.courseId === undefined ? {} : { courseId: options.courseId }),
    })
    const owner = this
    this.inbox = {
      get nextTurn() { return owner.pending.map(entry => entry.input) },
      get nextStep() { return owner.nextStep.map(entry => entry.input) },
      get hasPending() { return owner.pending.length > 0 || owner.nextStep.length > 0 },
      append: (target, input) => owner.enqueue(input, target, true, false),
      prepend: (target, input) => owner.enqueue(input, target, true, true),
      replace: (turnId, input) => owner.replaceQueued(turnId, input),
      remove: turnId => owner.removeQueued(turnId),
      clear: () => owner.clearQueued('cleared'),
    }
    this.modelSelection = this.runtime.modelSelection
    this.runtimePersisted = this.persistRuntimeState()
  }

  get status(): AgentStatus {
    return {
      agentId: this.options.agentId,
      sessionId: this.options.sessionId,
      parentAgentId: this.options.parentAgentId ?? null,
      phase: this.phase,
      queued: this.pending.length + this.nextStep.length,
      activeTurnId: this.active?.entry.turnId ?? null,
      cwd: this.runtime.cwd,
      capabilities: this.runtime.capabilities,
      modelSelection: this.modelSelection,
      preset: this.runtime.preset.id,
    }
  }

  /** Current model selection for the next turn. The active turn uses a snapshot. */
  get selection(): AgentModelSelection | null { return this.modelSelection }

  /** Select a model for future turns. Persistence can be disabled when the
   * host has already written the session/model event through its session
   * service, keeping the durable log append-only without duplicate edges. */
  async selectModel(selection: AgentModelSelection | null, persist = true): Promise<AgentModelSelection | null> {
    if (this.disposed) throw new Error('Agent 已销毁')
    if (selection !== null && (selection.provider.trim() === '' || selection.model.trim() === '')) {
      throw new Error('provider/model 不能为空')
    }
    this.modelSelection = selection === null ? null : {
      provider: selection.provider,
      model: selection.model,
      ...(selection.effort === undefined || selection.effort === null ? {} : { effort: selection.effort }),
    }
    if (persist) {
      if (this.modelSelection === null) {
        await this.append('session/model', { provider: '', model: '', cleared: true })
      } else {
        await this.append('session/model', {
          provider: this.modelSelection.provider,
          model: this.modelSelection.model,
          ...(this.modelSelection.effort === undefined || this.modelSelection.effort === null ? {} : { effort: this.modelSelection.effort }),
        })
      }
    }
    return this.modelSelection
  }

  /** Queue one user turn. The returned stream preserves model event order. */
  send(input: AgentTurnInput, target: InboxTarget = 'next-turn', wakeup = true): AgentTurnHandle {
    return this.enqueue(input, target, wakeup, false)
  }

  private enqueue(input: AgentTurnInput, target: InboxTarget, wakeup: boolean, prepend: boolean): AgentTurnHandle {
    if (this.disposed) throw new Error('Agent 已销毁')
    if (input.content.trim() === '') throw new Error('消息为空')
    const wakingAfterAbort = wakeup && this.active !== null && this.active.controller.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    const turnId = id('turn')
    const entry: QueueEntry = {
      turnId,
      input,
      target: resolvedTarget,
      queue: new AsyncEventQueue<AgentEvent>(),
      recovered: false,
      persisted: Promise.all([
        this.runtimePersisted,
        this.append('inbox/queued', {
        target: resolvedTarget,
        content: input.content,
        mode: input.mode ?? null,
        metadata: input.metadata ?? {},
        }, turnId),
      ]).then(() => undefined),
    }
    if (resolvedTarget === 'next-step' && this.active !== null) {
      if (prepend) this.nextStep.unshift(entry)
      else this.nextStep.push(entry)
    } else if (prepend) this.pending.unshift(entry)
    else this.pending.push(entry)
    if (this.active === null && this.pending.length + this.nextStep.length > 0) this.phase = 'queued'
    if (wakeup) this.wakeDriver(wakingAfterAbort)
    return { turnId: entry.turnId, events: entry.queue }
  }

  private replaceQueued(turnId: string, input: AgentTurnInput): boolean {
    if (this.disposed) return false
    if (input.content.trim() === '') throw new Error('消息为空')
    const entry = [...this.pending, ...this.nextStep].find(item => item.turnId === turnId)
    if (entry === undefined) return false
    entry.input = input
    this.appendQuietly('inbox/replaced', {
      content: input.content,
      mode: input.mode ?? null,
      metadata: input.metadata ?? {},
    }, turnId)
    return true
  }

  private removeQueued(turnId: string): boolean {
    if (this.disposed) return false
    const remove = (list: QueueEntry[]): QueueEntry | undefined => {
      const index = list.findIndex(item => item.turnId === turnId)
      if (index < 0) return undefined
      return list.splice(index, 1)[0]
    }
    const entry = remove(this.pending) ?? remove(this.nextStep)
    if (entry === undefined) return false
    entry.queue.close(new Error('Agent turn removed'))
    this.appendQuietly('inbox/dropped', { reason: 'removed' }, turnId)
    this.resolveIdle()
    return true
  }

  private clearQueued(reason: string): void {
    for (const entry of this.pending.splice(0)) {
      entry.queue.close(new Error('Agent turn cleared'))
      this.appendQuietly('inbox/dropped', { reason }, entry.turnId)
    }
    for (const entry of this.nextStep.splice(0)) {
      entry.queue.close(new Error('Agent turn cleared'))
      this.appendQuietly('inbox/dropped', { reason }, entry.turnId)
    }
    this.wakeRequested = false
    this.resolveIdle()
  }

  /** Reattach to a durable turn after a Host restart. Pending and active
   * entries retain their event queue, so transports can resume by turnId
   * without creating a duplicate inbox item. */
  attach(turnId: string): AgentTurnHandle | undefined {
    const entry = this.active?.entry.turnId === turnId
      ? this.active.entry
      : [...this.pending, ...this.nextStep].find(item => item.turnId === turnId)
      ?? this.injected.find(item => item.turnId === turnId)
    if (entry !== undefined) return { turnId: entry.turnId, events: entry.queue }
    // A completed turn is still attachable for replay. This is deliberately
    // event-log based so reconnecting transports do not depend on process
    // lifetime or the Host's transient handle maps.
    if (!this.completedTurnIds.has(turnId)) return undefined
    return { turnId, events: this.replayTurn(turnId) }
  }

  followup(input: AgentTurnInput): AgentTurnHandle { return this.send(input, 'next-turn', true) }
  steer(input: AgentTurnInput): AgentTurnHandle { return this.send(input, 'next-step', true) }
  /** Park model-visible context without waking or opening a new turn. */
  inject(input: AgentTurnInput): AgentTurnHandle {
    if (this.disposed) throw new Error('Agent 已销毁')
    if (input.content.trim() === '') throw new Error('消息为空')
    const turnId = id('context')
    const entry: QueueEntry = {
      turnId,
      input,
      target: 'next-step',
      contextOnly: true,
      queue: new AsyncEventQueue<AgentEvent>(),
      recovered: false,
      persisted: Promise.all([
        this.runtimePersisted,
        this.append('inbox/queued', {
          target: 'next-step',
          contextOnly: true,
          content: input.content,
          mode: input.mode ?? null,
          metadata: input.metadata ?? {},
        }, turnId),
      ]).then(() => undefined),
    }
    this.injected.push(entry)
    return { turnId, events: entry.queue }
  }

  /** Cancel the active turn and optionally discard queued turns. */
  cancel(options: { keepInbox?: boolean; cause?: AgentCancelCause } = {}): void {
    if (this.disposed) return
    if (!options.keepInbox) {
      for (const entry of this.pending.splice(0)) {
        entry.queue.close(new Error('Agent turn cancelled'))
        this.appendQuietly('inbox/dropped', { reason: options.cause ?? 'user' }, entry.turnId)
      }
      for (const entry of this.nextStep.splice(0)) {
        entry.queue.close(new Error('Agent turn cancelled'))
        this.appendQuietly('inbox/dropped', { reason: options.cause ?? 'user' }, entry.turnId)
      }
      this.wakeRequested = false
    }
    if (this.active !== null) {
      this.phase = 'cancelled'
      this.active.controller.abort(options.cause ?? 'user')
    } else if (this.phase === 'waiting') {
      this.phase = 'cancelled'
      this.resolveIdle()
    }
  }

  /** UI-13：仅清空排队/插话回合，绝不触碰正在运行的回合——QueueDock 的
   * "取消排队回合"语义（cancel({keepInbox:false}) 会连当前回合一起中止）。 */
  clearInbox(cause: AgentCancelCause = 'user'): number {
    if (this.disposed) return 0
    let removed = 0
    for (const entry of this.pending.splice(0)) {
      entry.queue.close(new Error('Agent turn cleared'))
      this.appendQuietly('inbox/dropped', { reason: cause }, entry.turnId)
      removed += 1
    }
    for (const entry of this.nextStep.splice(0)) {
      entry.queue.close(new Error('Agent turn cleared'))
      this.appendQuietly('inbox/dropped', { reason: cause }, entry.turnId)
      removed += 1
    }
    this.wakeRequested = false
    this.resolveIdle()
    return removed
  }

  /** Resolve once no active or queued work remains. */
  whenIdle(): Promise<void> {
    return this.waitForActivity()
  }

  private async waitForActivity(): Promise<void> {
    let activity: Promise<void>
    do {
      activity = this.activityDone
      if (this.active === null && this.maintenanceController === null && this.pending.length === 0 && this.nextStep.length === 0) return
      // PERF-9：activity 可能早已 settle（activityResolve 为 null），而
      // pending>0 却因驱动侧阻塞（如 restore() 挂起的 ask）长期不变——
      // 只 await 已完成 promise 是微任务热自旋，会饿死定时器/IO。加定时
      // 兜底强制回到宏任务队列。
      await Promise.race([
        activity,
        new Promise<void>(resolve => setTimeout(resolve, AgentLoop.ACTIVITY_TICK_MS)),
      ])
    } while (activity !== this.activityDone || this.active !== null || this.maintenanceController !== null || this.pending.length > 0 || this.nextStep.length > 0)
  }

  /** Run a non-turn maintenance operation from a true idle boundary. */
  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('Agent 已销毁')
    if (this.active !== null || this.pending.length > 0 || this.nextStep.length > 0) throw new Error('Agent 当前不空闲')
    const controller = new AbortController()
    this.maintenanceController = controller
    this.startActivity()
    this.phase = 'running'
    try {
      return await task(controller.signal)
    } finally {
      this.maintenanceController = null
      this.phase = 'idle'
      this.finishActivity()
      this.resolveIdle()
      if (!this.disposed && (this.pending.length > 0 || this.nextStep.length > 0)) this.wakeDriver()
    }
  }

  /** Record a DSH-style compaction boundary without rewriting the log. */
  async compact(summary: string | null = null): Promise<{ kind: 'compaction'; lastSeq: number; summary: string | null }> {
    return await this.runMaintenance(async () => {
      await this.append('maintenance/start', { kind: 'compaction' })
      const row = await this.append('compaction/applied', {
        summary: summary === null ? null : summary.slice(0, 8_000),
      })
      await this.append('maintenance/end', { kind: 'compaction', lastSeq: row.seq })
      return { kind: 'compaction', lastSeq: row.seq, summary: summary === null ? null : summary.slice(0, 8_000) }
    })
  }

  /** Dispose after aborting active work and draining all queue ownership. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.pending.splice(0)) {
      entry.queue.close(new Error('Agent disposed'))
      this.appendQuietly('inbox/dropped', { reason: 'disposed' }, entry.turnId)
    }
    for (const entry of this.nextStep.splice(0)) {
      entry.queue.close(new Error('Agent disposed'))
      this.appendQuietly('inbox/dropped', { reason: 'disposed' }, entry.turnId)
    }
    // Parked injected context is intentionally retained for replay/inspection;
    // disposal must not turn accepted tool results into dropped user work.
    for (const entry of this.injected) entry.queue.close(new Error('Agent disposed'))
    this.wakeRequested = false
    this.maintenanceController?.abort('disposed')
    this.active?.controller.abort('disposed')
    await this.whenIdle()
    // Ensure parked context queue records are ordered before the terminal
    // disposed marker; otherwise a fast teardown could append context after
    // `session/disposed` and make replay resurrect it.
    await Promise.all(this.injected.map(entry => entry.persisted))
    await this.runtimePersisted
    await this.append('session/disposed', {})
    this.phase = 'disposed'
  }

  /** Restore externally visible waiting/cancelled state from durable events. */
  async restore(): Promise<void> {
    await this.runtimePersisted
    const projection = await this.options.events.project(this.options.sessionId)
    if (projection.currentModel !== null && this.modelSelection === null) {
      this.modelSelection = { provider: projection.currentModel.provider, model: projection.currentModel.model }
    }
    if (!this.restored) {
      const rows = await this.options.events.load(this.options.sessionId)
      // RV-11：单趟有序重建。旧实现用 queued/interrupted 两个 Map，最后以
      // [...queued, ...interrupted] 拼接——"未出队的"排在"中断恢复的"前面，
      // 日志序「A 入队→A 出队（崩溃时在途）→B 入队」恢复后 pending=[B,A]：
      // 后入队的 B 先跑、在途的 A 后跑，用户消息的处理顺序被颠倒（事件日志
      // 的 user/input 序与回复落库序错位）。现在用单个 Map 保留首次入队次序
      // （inbox/replaced 只更新内容、不改次序），终态事件标记 done 跳过。
      type RestoredItem = { input: AgentTurnInput; target: InboxTarget; contextOnly?: boolean }
      const readItem = (row: (typeof rows)[number]): RestoredItem => ({
        target: row.payload['target'] === 'next-step' ? 'next-step' : 'next-turn',
        ...(row.payload['contextOnly'] === true ? { contextOnly: true } : {}),
        input: {
          content: String(row.payload['content'] ?? ''),
          ...(typeof row.payload['mode'] === 'string' ? { mode: row.payload['mode'] } : {}),
          ...(typeof row.payload['metadata'] === 'object' && row.payload['metadata'] !== null ? { metadata: row.payload['metadata'] as Record<string, unknown> } : {}),
        },
      })
      const items = new Map<string, RestoredItem>()
      const done = new Set<string>()
      const dequeued = new Set<string>()
      for (const row of rows) {
        const turnId = typeof row.payload['turnId'] === 'string' ? row.payload['turnId'] : ''
        if (turnId === '') continue
        if (row.type === 'inbox/queued') {
          // 同 turnId 重新入队（终态后复活）：清除终态标记，Map 位置保持首入次序。
          done.delete(turnId)
          items.set(turnId, readItem(row))
        } else if (row.type === 'inbox/dequeued') {
          dequeued.add(turnId)
          // queued 行缺失（损坏/旧版）时从 dequeued 行本身合成条目。
          if (!items.has(turnId)) items.set(turnId, readItem(row))
        } else if (row.type === 'inbox/replaced') {
          const existing = items.get(turnId)
          if (existing !== undefined) existing.input = readItem(row).input
        } else if (row.type === 'inbox/admitted' || row.type === 'inbox/dropped' || row.type === 'turn/end' || row.type === 'turn/error' || row.type === 'turn/cancelled') {
          done.add(turnId)
          if (row.type !== 'inbox/dropped') this.completedTurnIds.add(turnId)
        } else if (row.type === 'agent/context') {
          done.add(turnId)
        }
      }
      for (const [turnId, item] of items) {
        if (done.has(turnId)) continue
        const entry: QueueEntry = { turnId, input: item.input, target: item.target, ...(item.contextOnly === true ? { contextOnly: true } : {}), queue: new AsyncEventQueue<AgentEvent>(), recovered: dequeued.has(turnId), persisted: Promise.resolve() }
        if (item.contextOnly) this.injected.push(entry)
        else if (item.target === 'next-step') this.nextStep.push(entry)
        else this.pending.push(entry)
      }
      this.restored = true
    }
    if (projection.pendingAsk !== null || projection.pendingApprovals.length > 0) this.phase = 'waiting'
    else if (projection.phase === 'cancelled') this.phase = 'cancelled'
    else if (projection.phase === 'disposed') { this.phase = 'disposed'; this.disposed = true }
    else this.phase = this.active === null && (this.pending.length > 0 || this.nextStep.length > 0) ? 'queued' : 'idle'
    if (!this.disposed && projection.pendingAsk === null && projection.pendingApprovals.length === 0 && (this.pending.length > 0 || this.nextStep.length > 0)) this.wakeDriver()
  }

  async projection(): Promise<SessionProjection> {
    return this.options.events.project(this.options.sessionId)
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.disposed) return
    if (this.active !== null || this.maintenanceController !== null) {
      if (wakeAfterAbort) this.wakeRequested = true
      return
    }
    if (this.pending.length === 0 && this.nextStep.length === 0) {
      // A wake owns a turn boundary even when a caller immediately removes
      // its message. There is no empty turn in this transport, so just settle.
      this.resolveIdle()
      return
    }
    this.startActivity()
    void this.pump()
  }

  private startActivity(): void {
    if (this.active !== null || this.activityResolve !== null) return
    this.activityDone = new Promise(resolve => { this.activityResolve = resolve })
  }

  private finishActivity(): void {
    const resolve = this.activityResolve
    this.activityResolve = null
    resolve?.()
  }

  private takeNext(): QueueEntry | undefined {
    return this.nextStep.shift() ?? this.pending.shift()
  }

  private async pump(): Promise<void> {
    if (this.active !== null || this.disposed) return
    const entry = this.takeNext()
    if (entry === undefined) {
      this.finishActivity()
      this.resolveIdle()
      return
    }
    const controller = new AbortController()
    this.active = { entry, controller }
    this.phase = 'running'
    let inputTokens = 0
    let outputTokens = 0
    let assistantPrefix = ''
    let assistantMessageEmitted = false
    let turnModelSelection: AgentModelSelection | null = this.modelSelection
    let activeSteering: QueueEntry | null = null
    const appendCancellation = async (): Promise<void> => {
      // DSH persists the visible prefix when a model stream is interrupted so
      // replay does not have to infer it from transient chunk events.
      if (!assistantMessageEmitted && assistantPrefix.length > 0) {
        const modelPayload = turnModelSelection === null ? {} : { provider: turnModelSelection.provider, model: turnModelSelection.model }
        const payload = { content: assistantPrefix, interrupted: true as const, ...modelPayload }
        const row = await this.append('assistant/message', payload, entry.turnId)
        entry.queue.push({ agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: entry.turnId, type: 'assistant/message', payload, seq: row.seq })
      }
      const reason = controller.signal.reason ?? 'user'
      const cancelledPayload = { reason: typeof reason === 'string' ? reason : normalizeAbortReason(reason).kind }
      const cancelled = await this.append('turn/cancelled', cancelledPayload, entry.turnId)
      entry.queue.push({ agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: entry.turnId, type: 'turn/cancelled', payload: cancelledPayload, seq: cancelled.seq })
      if (activeSteering !== null) {
        activeSteering.queue.push({ agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: activeSteering.turnId, type: 'turn/cancelled', payload: cancelledPayload, seq: cancelled.seq })
        this.appendQuietly('inbox/dropped', { reason: 'cancelled' }, activeSteering.turnId)
        activeSteering.queue.close()
        activeSteering = null
      }
      await this.append('turn/end', { reason: { kind: 'aborted', reason: normalizeAbortReason(reason) } satisfies TurnEndReason }, entry.turnId)
      this.completedTurnIds.add(entry.turnId)
    }
    // 失败回合补偿的追踪：回合以错误收场且零可见输出（无 assistant 消息、
    // 无工具活动）时，把本回合的用户输入 void 掉——否则用户重发同一消息
    // 会在会话里留下一条重复的用户消息（SSE 失败残留，2026-09 修复）。
    // 声明在 try 之外：catch 的补偿路径需要读取它们。
    let userInputSeq: number | null = null
    let turnVisibleActivity = false
    try {
      await entry.persisted
      this.activeInjected = this.injected.splice(0)
      for (const context of this.activeInjected) {
        await context.persisted
        // 以 context 自己的 turnId 落账（而非主回合的）：restore 按
        // payload.turnId 分组清理，若挂在主回合名下，已消费上下文的
        // inbox/queued 行永不被剔除——重启后该上下文会被重复注入下一个
        // 无关回合；而主回合的恢复条目反被这条事件误删，中断回合不再续跑。
        await this.append('agent/context', {
          content: context.input.content,
          mode: context.input.mode ?? null,
          metadata: context.input.metadata ?? {},
          contextOnly: true,
        }, context.turnId)
        context.queue.close()
      }
      if (entry.recovered) {
        await this.append('turn/recovered', { target: entry.target }, entry.turnId)
      } else {
        await this.append('inbox/dequeued', {
          target: entry.target,
          content: entry.input.content,
          metadata: entry.input.metadata ?? {},
        }, entry.turnId)
        const userInputRow = await this.append('user/input', { content: entry.input.content, ...(entry.input.metadata ?? {}) }, entry.turnId)
        userInputSeq = userInputRow.seq
        await this.append('turn/start', { mode: entry.input.mode ?? 'socratic', target: entry.target }, entry.turnId)
      }
    let blockedByAsk = false
    let blockedByApproval = false
    // DSH treats steering admitted while a turn is active as another step
    // of that same turn. Keep the original turn boundary and only append a
    // new inbox/user input boundary for the steering item. This also keeps
    // queued steering handles useful to transports without creating a
    // second synthetic turn.
    // L3 口径说明：本回合的 inputTokens/outputTokens 是 length/4 的**粗估**
    // （事件流里拿不到上游真实用量），仅供 UI 展示相对规模，非精确计费数字。
    let currentInput = entry.input
      let continueTurn = true
      while (continueTurn) {
        let attempt = 0
        let stepComplete = false
        while (!stepComplete) {
          try {
            assistantPrefix = ''
            assistantMessageEmitted = false
            inputTokens += Math.max(1, Math.ceil(currentInput.content.length / 4))
            await this.append('step/start', { attempt }, entry.turnId)
            await this.append('request/start', { attempt, mode: currentInput.mode ?? null }, entry.turnId)
            // Capture selection once before prompt assembly/model work starts.
            // A concurrent switch applies to the next step, never half-way
            // through this request.
            const modelSelection = this.modelSelection
            turnModelSelection = modelSelection
            const runtime = await this.runtimeForTurn(modelSelection)
            const inbox = this.inboxView()
            for await (const event of this.options.runner(currentInput, {
              agentId: this.options.agentId,
              sessionId: this.options.sessionId,
              signal: controller.signal,
              inbox,
              runtime,
              cwd: runtime.cwd,
              capabilities: runtime.capabilities,
              scope: runtime.scope,
              preset: runtime.preset,
              modelSelection,
            })) {
              if (controller.signal.aborted && event.type !== 'turn/cancelled') break
              const payload = asPayload(event.payload)
              if (event.type === 'assistant/chunk' || event.type === 'assistant/reasoning') {
                const delta = String(payload['delta'] ?? payload['content'] ?? '')
                outputTokens += Math.ceil(delta.length / 4)
                if (event.type === 'assistant/chunk') assistantPrefix += delta
              } else if (event.type === 'assistant/message') {
                outputTokens += Math.ceil(String(payload['content'] ?? '').length / 4)
                assistantMessageEmitted = payload['interrupted'] !== true
                if (assistantMessageEmitted) turnVisibleActivity = true
                assistantPrefix = ''
              } else if (event.type === 'tool/call' || event.type === 'tool/result') {
                turnVisibleActivity = true
              }
              const row = await this.append(event.type, payload, entry.turnId)
              const output: AgentEvent = { agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: entry.turnId, type: event.type, payload, seq: row.seq }
              if (event.type === 'ask/pending') { this.phase = 'waiting'; blockedByAsk = true }
              if (event.type === 'approval/pending') { this.phase = 'waiting'; blockedByApproval = true }
              entry.queue.push(output)
              if (activeSteering !== null) activeSteering.queue.push({ ...output, turnId: activeSteering.turnId })
            }
            await this.append('request/end', { attempt }, entry.turnId)
            await this.append('step/end', { attempt }, entry.turnId)
            stepComplete = true
          } catch (error) {
            await this.append('request/error', { attempt, message: error instanceof Error ? error.message : String(error) }, entry.turnId)
            await this.append('step/error', { attempt, message: error instanceof Error ? error.message : String(error) }, entry.turnId)
            if (controller.signal.aborted || this.options.retry === undefined || !(await this.options.retry(error, attempt, controller.signal))) throw error
            attempt += 1
            await this.append('request/retry', { attempt, message: error instanceof Error ? error.message : String(error) }, entry.turnId)
            const delay = Math.max(0, this.options.retryDelayMs ?? 250) * attempt
            if (delay > 0) await waitWithAbort(delay, controller.signal)
          }
        }
        if (activeSteering !== null) {
          await this.append('inbox/admitted', { target: 'next-step', parentTurnId: entry.turnId }, activeSteering.turnId)
          activeSteering.queue.close()
          activeSteering = null
        }
        if (!controller.signal.aborted && !blockedByAsk && !blockedByApproval && this.nextStep.length > 0) {
          activeSteering = this.nextStep.shift() ?? null
          if (activeSteering !== null) {
            await activeSteering.persisted
            await this.append('inbox/dequeued', {
              target: 'next-step',
              content: activeSteering.input.content,
              metadata: activeSteering.input.metadata ?? {},
              steering: true,
            }, activeSteering.turnId)
            await this.append('user/input', {
              content: activeSteering.input.content,
              steering: true,
              ...(activeSteering.input.metadata ?? {}),
            }, activeSteering.turnId)
            currentInput = activeSteering.input
            continue
          }
        }
        continueTurn = false
      }
      if (controller.signal.aborted) {
        this.phase = 'cancelled'
        await appendCancellation()
      } else {
        const model = (await this.options.events.project(this.options.sessionId)).currentModel
        await this.append('usage', {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(model === null ? {} : { provider: model.provider, model: model.model }),
        }, entry.turnId)
        const reason: TurnEndReason = blockedByAsk || blockedByApproval
          ? { kind: 'blocked', blockers: [...(blockedByAsk ? ['ask-user' as const] : []), ...(blockedByApproval ? ['approval' as const] : [])] }
          : { kind: 'completed' }
        await this.append('turn/end', { reason }, entry.turnId)
        this.completedTurnIds.add(entry.turnId)
        if (this.phase !== 'waiting') this.phase = 'idle'
      }
      entry.queue.close()
    } catch (error) {
      if (controller.signal.aborted) {
        this.phase = 'cancelled'
        await appendCancellation()
        entry.queue.close()
        return
      }
      this.phase = 'idle'
      const message = error instanceof Error ? error.message : String(error)
      const row = await this.append('turn/error', { message }, entry.turnId)
      entry.queue.push({ agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: entry.turnId, type: 'turn/error', payload: { message }, seq: row.seq })
      if (userInputSeq !== null && !turnVisibleActivity) {
        // 零可见输出的失败回合：补写补偿事件把用户输入从投影中剔除。写入失败
        // 时退化为旧行为（保留输入），不掩盖原始错误。
        try {
          await this.append('input/voided', { seq: userInputSeq, reason: 'turn-failed' }, entry.turnId)
        } catch { /* 保留输入，退化旧行为 */ }
      }
      if (activeSteering !== null) {
        activeSteering.queue.push({ agentId: this.options.agentId, sessionId: this.options.sessionId, turnId: activeSteering.turnId, type: 'turn/error', payload: { message }, seq: row.seq })
        this.appendQuietly('inbox/dropped', { reason: 'error' }, activeSteering.turnId)
        activeSteering.queue.close(error)
        activeSteering = null
      }
      await this.append('turn/end', { reason: { kind: 'error', error: { message, code: 'UNKNOWN' } } satisfies TurnEndReason }, entry.turnId)
      this.completedTurnIds.add(entry.turnId)
      entry.queue.close(error)
    } finally {
      this.activeInjected = []
      this.active = null
      if (this.disposed) {
        this.phase = 'disposed'
        this.finishActivity()
      } else if (this.pending.length > 0 || this.nextStep.length > 0) {
        this.phase = 'running'
        void this.pump()
      } else {
        this.phase = this.phase === 'cancelled' ? 'cancelled' : this.phase === 'waiting' ? 'waiting' : 'idle'
        this.finishActivity()
        this.resolveIdle()
        if (this.wakeRequested && (this.pending.length > 0 || this.nextStep.length > 0)) {
          this.wakeRequested = false
          this.wakeDriver()
        }
      }
    }
  }

  private inboxView(): AgentRunnerContext['inbox'] {
    const thisAgent = this
    const inputOf = (entries: readonly QueueEntry[]): readonly AgentTurnInput[] => entries.map(entry => entry.input)
    return {
      get nextTurn() { return inputOf(thisAgent.pending) },
      get nextStep() { return inputOf(thisAgent.nextStep) },
      get injected() { return inputOf([...thisAgent.activeInjected, ...thisAgent.injected]) },
      drain(target: InboxTarget): AgentTurnInput[] {
        const entries = target === 'next-step' ? thisAgent.nextStep.splice(0) : thisAgent.pending.splice(0)
        return entries.map(entry => entry.input)
      },
    }
  }

  private async append(type: string, payload: Record<string, unknown>, turnId?: string): Promise<SessionEventEnvelope> {
    return (await this.options.events.append(this.options.sessionId, { ts: utcTs(), type, payload: turnId === undefined ? payload : { ...payload, turnId } }))[0]!
  }

  /**
   * RV-13：best-effort 审计行（清理路径的 inbox/dropped、inbox/replaced 等）。
   * `this.appendQuietly(...)` 在磁盘满/Windows 文件锁重试耗尽/只读目录等 I/O
   * 失败时会升级为 unhandledRejection——bin.ts 未安装全局兜底，Node 15+ 默认
   * 行为即终止进程：Host 会在 cancel/dispose/remove 的清理路径上被自己的审计
   * 写入打崩，在途回合全丢。清理路径的审计丢失可恢复，进程崩溃不可恢复。
   */
  private appendQuietly(type: string, payload: Record<string, unknown>, turnId?: string): void {
    void this.append(type, payload, turnId).catch(() => undefined)
  }

  private async *replayTurn(turnId: string): AsyncIterable<AgentEvent> {
    const rows = await this.options.events.load(this.options.sessionId)
    for (const row of rows) {
      if (row.payload['turnId'] !== turnId) continue
      yield {
        agentId: this.options.agentId,
        sessionId: this.options.sessionId,
        turnId,
        type: row.type,
        payload: row.payload,
        seq: row.seq,
      }
    }
  }

  private async runtimeForTurn(modelSelection: AgentModelSelection | null): Promise<AgentRuntimeState> {
    if (this.options.promptRegistry === undefined) return { ...this.runtime, modelSelection }
    const context: AgentPromptContext = {
      scope: this.runtime.scope,
      model: modelSelection,
      capabilities: this.runtime.capabilities,
      preset: this.runtime.preset,
    }
    const assembled = await this.options.promptRegistry.assemble(context)
    return { ...this.runtime, modelSelection, systemPrompt: assembled === '' ? this.runtime.systemPrompt : assembled }
  }

  /** Persist the immutable runtime contract once, before the first inbox edge. */
  private async persistRuntimeState(): Promise<void> {
    const rows = await this.options.events.load(this.options.sessionId).catch(() => [])
    if (rows.some(row => row.type === 'agent/runtime')) return
    await this.options.events.append(this.options.sessionId, {
      ts: utcTs(),
      type: 'agent/runtime',
      payload: {
        agentId: this.options.agentId,
        sessionId: this.options.sessionId,
        cwd: this.runtime.cwd,
        scope: this.runtime.scope,
        preset: this.runtime.preset,
        permissionPreset: this.runtime.permissionPreset,
        capabilities: this.runtime.capabilities,
        systemPrompt: this.runtime.systemPrompt,
        ...(this.modelSelection === null ? {} : { provider: this.modelSelection.provider, model: this.modelSelection.model, ...(this.modelSelection.effort === undefined || this.modelSelection.effort === null ? {} : { effort: this.modelSelection.effort }) }),
      },
    })
  }

  private resolveIdle(): void {
    if (this.active !== null || this.pending.length > 0 || this.nextStep.length > 0) return
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}

async function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('agent cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('agent cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Registry for live agents, shared by Host, CLI, ACP, and Web adapters. */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>()

  register(agent: Agent): () => void {
    const key = agent.options.agentId
    if (this.agents.has(key)) throw new Error(`Agent 已存在: ${key}`)
    this.agents.set(key, agent)
    return () => {
      if (this.agents.get(key) === agent) this.agents.delete(key)
    }
  }

  get(agentId: string): Agent | undefined { return this.agents.get(agentId) }

  list(): AgentStatus[] { return [...this.agents.values()].map(agent => agent.status) }

  status(agentId: string): AgentStatus {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    return agent.status
  }

  async cancel(agentId: string, keepInbox = false): Promise<AgentStatus> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    agent.cancel({ keepInbox })
    return agent.status
  }

  /** UI-13：仅清空排队回合，不中止当前回合。 */
  clearInbox(agentId: string): number {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    return agent.clearInbox()
  }

  async whenIdle(agentId: string): Promise<AgentStatus> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    await agent.whenIdle()
    return agent.status
  }

  async selectModel(agentId: string, selection: AgentModelSelection | null, persist = true): Promise<AgentModelSelection | null> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    return agent.selectModel(selection, persist)
  }

  async dispose(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (agent === undefined) throw new Error(`Agent 不存在: ${agentId}`)
    await agent.dispose()
    this.agents.delete(agentId)
  }
}

/**
 * Named DSH-compatible loop surface. Agent remains the implementation for
 * backwards compatibility; new Host/ACP integrations can depend on the
 * explicit loop name without duplicating queue or cancellation logic.
 */
export class AgentLoop extends Agent {}

export type { SessionEventStore, SessionEventEnvelope, SessionProjection } from '@studyclaw/session'
