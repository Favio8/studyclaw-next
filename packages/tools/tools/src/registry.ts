/**
 * ToolRegistry: registration, OpenAI function-calling schema projection,
 * mode-based policy filtering (M-C), lightweight JSON-Schema argument
 * validation, and three-state execution with timeout. Ported from Python
 * `agent_tools.py::ToolRegistry`.
 * @module @studyclaw/tools/src/registry
 */

import { ToolError, ToolRejected, ToolResult } from './result.ts'
import { MAX_PARALLEL_TOOL_CALLS, type ToolSpec } from './specs.ts'
import type { ToolContext } from './handlers.ts'

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<[string, Record<string, unknown>]>

export interface ToolBatchCall {
  readonly callId: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly parentCallId?: string | null
}

export interface ToolBatchResult {
  readonly call: ToolBatchCall
  readonly result: ToolResult
}

/** DSH-style middleware boundaries around one tool dispatch. */
export interface ToolRuntimeExecution {
  readonly name: string
  readonly args: Record<string, unknown> | null | undefined
  readonly ctx: ToolContext
  readonly timeout?: number
}

export interface ToolRuntimeMiddleware {
  /** Fail closed before approval/handler execution. */
  readonly preExecute?: (execution: ToolRuntimeExecution) => Promise<void> | void
  /** Wrap the normalized registry dispatch (timeout/retry may be layered here). */
  readonly aroundExecute?: (execution: ToolRuntimeExecution, next: () => Promise<ToolResult>) => Promise<ToolResult>
  /** Observe the durable-safe final result. */
  readonly postExecute?: (execution: ToolRuntimeExecution, result: ToolResult) => Promise<void> | void
}

/** Four-mode policy table (Sprint 8 M-C): mode → allowed tool names. */
export const MODE_TOOL_SETS: Record<string, string[]> = {
  socratic: ['read_source', 'search_sources', 'read_file', 'search_files', 'get_course_state', 'get_task_pool', 'get_memory', 'ask_user_question', 'plan', 'todo'],
  quick: ['read_source', 'search_sources', 'read_file', 'search_files', 'get_course_state', 'run_review', 'run_quiz', 'evaluate_answer', 'ask_user_question', 'plan', 'todo'],
  feynman: ['read_source', 'search_sources', 'read_file', 'search_files', 'get_course_state', 'get_task_pool', 'write_note', 'write_file', 'ask_user_question', 'plan', 'todo'],
  debug: ['read_source', 'search_sources', 'read_file', 'search_files', 'get_course_state', 'get_task_pool', 'generate_dynamic_card', 'run_quiz', 'evaluate_answer', 'write_file', 'run_command', 'fetch_url', 'search_web', 'spawn_agent', 'ask_user_question', 'plan', 'todo'],
  // The general Agent preset is intentionally independent from learning
  // modes. It exposes the DSH-style workspace/runtime tools while keeping
  // approval-gated mutations and deployment providers fail-closed.
  general: ['read_file', 'search_files', 'write_file', 'run_command', 'fetch_url', 'search_web', 'spawn_agent', 'lsp', 'ask_user_question', 'plan', 'todo'],
}

const READONLY_FALLBACK_TOOLS = ['read_source', 'search_sources', 'get_course_state']

/** Allowed tool names for a mode; unknown modes fail closed to the readonly subset. */
export function modeToolNames(mode: string): string[] {
  return MODE_TOOL_SETS[mode] ?? READONLY_FALLBACK_TOOLS
}

/** JSON-Schema property node coercion (string/integer/number/boolean). */
function coerce(node: Record<string, unknown>, key: string, value: unknown): unknown {
  const alternatives = node['anyOf']
  if (Array.isArray(alternatives)) {
    const errors: string[] = []
    for (const alternative of alternatives) {
      if (typeof alternative !== 'object' || alternative === null || Array.isArray(alternative)) continue
      try {
        return coerce(alternative as Record<string, unknown>, key, value)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    throw new ToolRejected(`${key} 不符合任一允许的参数形状${errors.length > 0 ? `: ${errors.join('；')}` : ''}`)
  }
  const enumValues = node['enum']
  if (Array.isArray(enumValues) && !enumValues.some(candidate => Object.is(candidate, value))) {
    throw new ToolRejected(`${key} 必须是 ${enumValues.map(String).join('、')} 之一`)
  }
  const expected = node['type']
  if (expected === 'string') {
    if (typeof value !== 'string') throw new ToolRejected(`${key} 应为字符串`)
    if (typeof node['minLength'] === 'number' && value.length < node['minLength']) {
      throw new ToolRejected(`${key} 长度不能小于 ${node['minLength']}`)
    }
    if (typeof node['maxLength'] === 'number' && value.length > node['maxLength']) {
      throw new ToolRejected(`${key} 长度不能大于 ${node['maxLength']}`)
    }
    // Preserve the validated value for execution. Durable/UI projections use
    // `publicToolArgs` to redact and crop arguments after validation; cropping
    // here would silently corrupt notes, answers, cards, and file writes.
    return value
  }
  if (expected === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolRejected(`${key} 应为整数`)
    if (typeof node['minimum'] === 'number' && value < node['minimum']) throw new ToolRejected(`${key} 不能小于 ${node['minimum']}`)
    if (typeof node['maximum'] === 'number' && value > node['maximum']) throw new ToolRejected(`${key} 不能大于 ${node['maximum']}`)
    return value
  }
  if (expected === 'number') {
    if (typeof value !== 'number') throw new ToolRejected(`${key} 应为数字`)
    if (typeof node['minimum'] === 'number' && value < node['minimum']) throw new ToolRejected(`${key} 不能小于 ${node['minimum']}`)
    if (typeof node['maximum'] === 'number' && value > node['maximum']) throw new ToolRejected(`${key} 不能大于 ${node['maximum']}`)
    return value
  }
  if (expected === 'boolean') {
    if (typeof value !== 'boolean') throw new ToolRejected(`${key} 应为布尔`)
    return value
  }
  if (expected === 'array') {
    if (!Array.isArray(value)) throw new ToolRejected(`${key} 应为数组`)
    if (typeof node['minItems'] === 'number' && value.length < node['minItems']) throw new ToolRejected(`${key} 至少需要 ${node['minItems']} 项`)
    if (typeof node['maxItems'] === 'number' && value.length > node['maxItems']) throw new ToolRejected(`${key} 最多允许 ${node['maxItems']} 项`)
    const itemSchema = node['items']
    if (typeof itemSchema === 'object' && itemSchema !== null && !Array.isArray(itemSchema)) {
      return value.map((item, index) => coerce(itemSchema as Record<string, unknown>, `${key}[${index}]`, item))
    }
    return value
  }
  if (expected === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ToolRejected(`${key} 应为对象`)
    const properties = node['properties']
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const [property, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (property in (value as Record<string, unknown>) && typeof propertySchema === 'object' && propertySchema !== null && !Array.isArray(propertySchema)) {
          coerce(propertySchema as Record<string, unknown>, `${key}.${property}`, (value as Record<string, unknown>)[property])
        }
      }
    }
    return value
  }
  return value
}

/** Tool registry over one course: specs + handlers, policy filtering, execution. */
export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>()
  private readonly handlers = new Map<string, ToolHandler>()
  /** Action/write/interactive post-write audit (name/status/summary only). */
  readonly actionAudit: Array<{ name: string; status: string; summary: string; ts: string; durationMs: number }> = []

  constructor(
    readonly courseDir: string,
    readonly workspaceRoot: string,
  ) {}

  register(spec: ToolSpec, handler: ToolHandler): void {
    if (this.specs.has(spec.name)) throw new Error(`工具重复注册: ${spec.name}`)
    if (!['read', 'action', 'write', 'interactive'].includes(spec.policy)) {
      throw new Error(`当前阶段只允许 read | action | write | interactive 策略，收到 ${spec.policy!}`)
    }
    this.specs.set(spec.name, spec)
    this.handlers.set(spec.name, handler)
  }

  has(name: string): boolean {
    return this.specs.has(name)
  }

  spec(name: string): ToolSpec | undefined {
    return this.specs.get(name)
  }

  policy(name: string): ToolSpec['policy'] | undefined {
    return this.specs.get(name)?.policy
  }

  names(): string[] {
    return [...this.specs.keys()].sort()
  }

  specsSorted(): ToolSpec[] {
    return this.names().map(name => this.specs.get(name)!)
  }

  /** OpenAI function-calling `tools` shape (full inventory). */
  schemas(): Record<string, unknown>[] {
    return this.specsSorted().map(spec => ({
      type: 'function',
      function: { name: spec.name, description: spec.description, parameters: spec.parameters },
    }))
  }

  /** Mode-filtered tool names; unknown mode falls back to the readonly subset. */
  namesForMode(mode: string): string[] {
    const allowed = modeToolNames(mode)
    return allowed.filter(name => this.specs.has(name)).sort()
  }

  /** Mode-filtered `tools` shape (the LLM-facing projection). */
  schemasForMode(mode: string): Record<string, unknown>[] {
    const allowed = new Set(this.namesForMode(mode))
    return this.specsSorted()
      .filter(spec => allowed.has(spec.name))
      .map(spec => ({
        type: 'function',
        function: { name: spec.name, description: spec.description, parameters: spec.parameters },
      }))
  }

  /** Execute one call: validate → approval → handler with timeout → result. */
  async execute(
    name: string,
    arguments_: Record<string, unknown> | null | undefined,
    ctx: ToolContext,
    timeout?: number,
  ): Promise<ToolResult> {
    const spec = this.specs.get(name)
    if (spec === undefined) {
      const result = ToolResult.rejected(`未知工具: ${name}`, 'TOOL_NOT_FOUND')
      this.auditAction(name, result)
      return result
    }
    let clean: Record<string, unknown>
    try {
      clean = validateArguments(spec, arguments_)
    } catch (error) {
      return ToolResult.rejected(`参数非法: ${error instanceof Error ? error.message : String(error)}`, error instanceof ToolError ? error.code : 'TOOL_INVALID_ARGS', spec.renderIntent)
    }
    const requiresApproval = spec.requiresApproval ?? spec.policy !== 'read'
    // Every externally mutating action, including course writes/evaluation,
    // must have an explicit approval channel. A direct registry caller cannot
    // silently bypass the Host policy by omitting the broker.
    const requiresApprovalChannel = requiresApproval
    if (requiresApprovalChannel && ctx.approval === undefined) {
      const result = ToolResult.degraded('工具需要用户确认，但当前 Host 未提供审批通道', 'APPROVAL_UNAVAILABLE', spec.renderIntent)
      this.auditAction(spec.name, result)
      return result
    }
    if (requiresApproval && ctx.approval !== undefined) {
      const decision = await raceWithAbort(ctx.approval({ name: spec.name, policy: spec.policy, args: clean }), ctx.signal)
      if (decision !== 'allow') {
        const result = ToolResult.rejected(`工具 ${spec.name} 未获用户确认`, 'APPROVAL_DENIED', spec.renderIntent)
        this.auditAction(spec.name, result)
        return result
      }
    }
    const handler = this.handlers.get(name)
    if (handler === undefined) {
      return ToolResult.rejected(`工具未接线: ${name}`, 'HANDLER_MISSING', spec.renderIntent)
    }
    const started = Date.now()
    let result: ToolResult
    try {
      const raw: unknown = await withTimeout(
        signal => handler({ ...ctx, signal }, clean),
        timeout ?? spec.timeout,
        ctx.signal,
      )
      if (!Array.isArray(raw) || raw.length < 2 || typeof raw[0] !== 'string' || !isRecord(raw[1])) {
        throw new ToolError('工具返回了无效结果', 'TOOL_INVALID_OUTPUT')
      }
      result = new ToolResult('success', raw[0], raw[1], null, Date.now() - started, spec.renderIntent)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = message === 'tool cancelled' || ctx.signal?.aborted === true
      const timedOut = message.startsWith('tool timeout after ')
      const rejected = error instanceof ToolRejected || cancelled
      const code = cancelled ? 'TOOL_CANCELLED' : timedOut ? 'TOOL_TIMEOUT' : error instanceof ToolError ? error.code : 'TOOL_EXECUTION_FAILED'
      result = new ToolResult(rejected ? 'rejected' : 'degraded', message, {}, code, Date.now() - started, spec.renderIntent)
    }
    if (spec.policy !== 'read') this.auditAction(spec.name, result)
    return result
  }

  /** DSH-style retry wrapper. Rejected arguments/permissions are never retried. */
  async executeWithRetry(
    name: string,
    arguments_: Record<string, unknown> | null | undefined,
    ctx: ToolContext,
    options: { timeout?: number; retries?: number; backoffMs?: number } = {},
  ): Promise<ToolResult> {
    const spec = this.specs.get(name)
    const retries = Math.max(0, Math.floor(options.retries ?? spec?.retry.maxRetries ?? 0))
    let result = await this.execute(name, arguments_, ctx, options.timeout)
    for (let attempt = 0; attempt < retries && result.status === 'degraded'; attempt += 1) {
      const delay = Math.max(0, options.backoffMs ?? spec?.retry.backoffMs ?? 50) * (attempt + 1)
      if (delay > 0) await waitForDelay(delay, ctx.signal)
      result = await this.execute(name, arguments_, ctx, options.timeout)
    }
    return result
  }

  /**
   * DSH tool-call scheduler: read calls share a bounded parallel pool while
   * action/write/interactive calls create ordered exclusive barriers. Results
   * are returned in model order even when providers finish out of order.
   */
  async executeBatch(
    calls: readonly ToolBatchCall[],
    ctx: ToolContext,
    options: { timeout?: number; retries?: number; backoffMs?: number; maxParallel?: number } = {},
  ): Promise<ToolBatchResult[]> {
    const maxParallel = Math.max(1, Math.floor(options.maxParallel ?? MAX_PARALLEL_TOOL_CALLS))
    const results: Array<ToolBatchResult | undefined> = Array.from({ length: calls.length })
    let cursor = 0
    while (cursor < calls.length) {
      if (ctx.signal?.aborted) {
        for (; cursor < calls.length; cursor += 1) {
          const call = calls[cursor]!
          results[cursor] = { call, result: abortedBeforeDispatch() }
        }
        break
      }
      const first = calls[cursor]!
      const firstSpec = this.spec(first.name)
      const isParallel = firstSpec?.execution === 'parallel'
      if (!isParallel) {
        cursor += 1
        results[cursor - 1] = {
          call: first,
          result: await this.executeBatchCall(first, ctx, options),
        }
        continue
      }

      // Keep the whole contiguous parallel group visible so a fast call can
      // replenish the bounded pool before slower siblings settle. The next
      // exclusive call remains a hard barrier and is only dispatched after
      // every parallel sibling has produced a model-ordered result.
      const groupStart = cursor
      while (cursor < calls.length && this.spec(calls[cursor]!.name)?.execution === 'parallel') cursor += 1
      const group = calls.slice(groupStart, cursor)
      const inFlight = new Map<number, Promise<{ index: number; result?: ToolResult; error?: unknown }>>()
      let next = 0
      let committed = 0
      let schedulerFailure: unknown = undefined
      const dispatch = (index: number): void => {
        const call = group[index]!
        const promise = this.executeBatchCall(call, ctx, options)
          .then(result => ({ index, result }), error => ({ index, error }))
        inFlight.set(index, promise)
      }
      const fill = (): void => {
        while (schedulerFailure === undefined && !ctx.signal?.aborted && next < group.length && inFlight.size < maxParallel) {
          dispatch(next)
          next += 1
        }
      }
      fill()
      while (inFlight.size > 0) {
        const settled = await Promise.race(inFlight.values())
        inFlight.delete(settled.index)
        if (settled.error !== undefined) {
          schedulerFailure = settled.error
          await Promise.all(inFlight.values())
          throw schedulerFailure
        }
        const call = group[settled.index]!
        results[groupStart + settled.index] = { call, result: settled.result! }
        committed += 1
        fill()
      }
      // Cancellation stops replenishment but still returns a durable pair for
      // each model call, including calls that never reached a provider.
      if (ctx.signal?.aborted && next < group.length) {
        for (; next < group.length; next += 1) {
          const call = group[next]!
          results[groupStart + next] = { call, result: abortedBeforeDispatch() }
        }
      }
      // Defensive invariant: every member of a drained group has a result.
      if (committed + (group.length - next) !== group.length) {
        for (let index = 0; index < group.length; index += 1) {
          if (results[groupStart + index] === undefined) {
            const call = group[index]!
            results[groupStart + index] = { call, result: abortedBeforeDispatch() }
          }
        }
      }
    }
    return results.filter((item): item is ToolBatchResult => item !== undefined)
  }

  private async executeBatchCall(
    call: ToolBatchCall,
    ctx: ToolContext,
    options: { timeout?: number; retries?: number; backoffMs?: number },
  ): Promise<ToolResult> {
    try {
      return await this.executeWithRetry(call.name, call.args, ctx, options)
    } catch (error) {
      if (ctx.signal?.aborted) return ToolResult.rejected('工具调用已取消', 'TOOL_CANCELLED')
      throw error
    }
  }

  private auditAction(name: string, result: ToolResult): void {
    this.actionAudit.push({
      name,
      status: result.status,
      summary: result.summary,
      ts: new Date().toISOString(),
      durationMs: Math.round(result.durationMs * 10) / 10,
    })
  }
}

/** Durable synthetic result for a model call skipped after cancellation. */
function abortedBeforeDispatch(): ToolResult {
  return ToolResult.rejected('工具调用在分发前已取消', 'TOOL_ABORTED_BEFORE_DISPATCH')
}

/**
 * Shared DSH-style tool runtime facade. It keeps the existing registry as the
 * source of schemas/handlers while exposing explicit pre/around/post seams to
 * Agent, Host, and ACP adapters. Middleware failures become structured
 * degraded results and never bypass the registry's approval gate.
 */
export class ToolRuntime extends ToolRegistry {
  constructor(
    courseDir: string,
    workspaceRoot: string,
    readonly middleware: readonly ToolRuntimeMiddleware[] = [],
  ) {
    super(courseDir, workspaceRoot)
  }

  override async execute(
    name: string,
    arguments_: Record<string, unknown> | null | undefined,
    ctx: ToolContext,
    timeout?: number,
  ): Promise<ToolResult> {
    const execution: ToolRuntimeExecution = { name, args: arguments_, ctx, ...(timeout === undefined ? {} : { timeout }) }
    let result: ToolResult
    try {
      for (const layer of this.middleware) await layer.preExecute?.(execution)
      let dispatch = (): Promise<ToolResult> => super.execute(name, arguments_, ctx, timeout)
      for (const layer of [...this.middleware].reverse()) {
        const next = dispatch
        if (layer.aroundExecute !== undefined) dispatch = () => layer.aroundExecute!(execution, next)
      }
      result = await dispatch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const renderIntent = this.spec(name)?.renderIntent ?? null
      if (ctx.signal?.aborted) {
        result = ToolResult.rejected('工具调用已取消', 'TOOL_CANCELLED', renderIntent)
      } else {
        result = error instanceof ToolRejected
          ? ToolResult.rejected(message, error.code, renderIntent)
          : ToolResult.degraded(message, error instanceof ToolError ? error.code : 'TOOL_RUNTIME_MIDDLEWARE', renderIntent)
      }
    }
    // Projection is observational and must run at most once per middleware.
    // A broken projection cannot turn an already completed handler into an
    // unhandled RPC rejection; expose the failure as a structured degraded
    // result while preserving the original result when projection succeeds.
    for (const layer of this.middleware) {
      try {
        await layer.postExecute?.(execution, result)
      } catch (error) {
        if (result.status === 'success') {
          const message = error instanceof Error ? error.message : String(error)
          result = ToolResult.degraded(`工具结果投影失败: ${message}`, 'TOOL_RUNTIME_POST_EXECUTE', this.spec(name)?.renderIntent ?? null)
        }
      }
    }
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON-Schema argument validation: required/unknown/property coercion. */
function validateArguments(spec: ToolSpec, arguments_: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const args = arguments_ ?? {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolRejected('参数必须是 JSON 对象')
  const properties = (spec.parameters['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((spec.parameters['required'] ?? []) as string[])
  const missing = [...required].filter(key => !(key in args))
  if (missing.length > 0) throw new ToolRejected(`缺少必填参数: ${missing.sort().join(', ')}`)
  const unknown = Object.keys(args).filter(key => !(key in properties))
  if (unknown.length > 0) {
    throw new ToolRejected(`未知参数: ${unknown.sort().join(', ')}（可用参数: ${Object.keys(properties).sort().join(', ')}）`)
  }
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    cleaned[key] = coerce(properties[key]!, key, value)
  }
  return cleaned
}

/**
 * Run a handler with a child signal. A timeout must stop providers that honor
 * AbortSignal, while a caller cancellation must retain its structured
 * TOOL_CANCELLED result. The child is deliberately scoped to one call so a
 * timed-out tool cannot abort sibling calls in the same parallel batch.
 */
async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  seconds: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parentSignal?.reason ?? 'caller')
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort('timeout')
      reject(new Error(`tool timeout after ${seconds}s`))
    }, seconds * 1000)
  })
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted && controller.signal.reason !== 'timeout') reject(new Error('tool cancelled'))
    else controller.signal.addEventListener('abort', () => {
      if (controller.signal.reason !== 'timeout') reject(new Error('tool cancelled'))
    }, { once: true })
  })
  const promise = task(controller.signal)
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

async function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('tool cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('tool cancelled')) }, { once: true })
  })
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) throw new Error('tool cancelled')
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('tool cancelled')), { once: true })),
  ])
}
