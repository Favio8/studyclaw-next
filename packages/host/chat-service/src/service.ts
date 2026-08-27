/**
 * Session service: the host-side seam the RPC layer calls — session listing,
 * creation, restore, and the chat stream over one course, wired to
 * TutorSession + defaultToolRegistry + the config-backed LLM client.
 * @module @studyclaw/chat-service/src/service
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AgentLoop, ApprovalQueue, type AgentCapability, type AgentEvent, type AgentModelSelection, type AgentPreset, type AgentRegistry, type ApprovalDecision, type ApprovalRequest, type AgentTurnHandle } from '@studyclaw/agent'
import {
  agentToolRegistry,
  resolveSourceRef,
  type ToolActionContext,
  type ToolActions,
  type ToolHandlerResult,
  type ToolProviders,
} from '@studyclaw/tools'
import { SessionEventStore, SessionStore, SessionError, TutorSession, utcTs, sessionModelLine, publicToolArgs, studyclawFallbackTitle, normalizeSessionTitle, type ChatEvent, type LearningMode, type SessionProjection } from '@studyclaw/session'
import type { ResolvedChatConfig } from './config.ts'
import { createDeepSeekToolClient, reasoningEffortsForConfig } from './adapter.ts'
import { configProblem, createCourseService, type CourseService } from './course.ts'
import { loadChatConfig } from './config.ts'
import { discoverModels, settingsPayload, saveProvider } from './settings.ts'
import { stateDirOf } from '@studyclaw/course-builder'

export interface SessionSummaryView {
  readonly sessionId: string
  readonly title: string
  readonly mode: string
  readonly turns: number
  readonly createdAt: string
  readonly lastActiveAt: string
}

/** One JSONL content-search match within a course. */
export interface SessionSearchView extends SessionSummaryView {
  /** A compact, whitespace-normalized excerpt around the first body match. */
  readonly snippet?: string
  /** Title hits lead body hits when a workspace aggregates its results. */
  readonly match: 'title' | 'content'
}

export interface RestoredSessionView {
  readonly sessionId: string
  readonly title: string
  readonly mode: string
  readonly restored: boolean
  readonly turns: Array<{ role: 'user' | 'agent'; ts: string; content: string }>
  readonly suggestedEntry: string | null
  readonly wakeup: null
  readonly pendingAsk: { question: string } | null
}

export interface SessionModelSelection { readonly provider: string; readonly model: string; readonly effort?: string | null }
export interface SessionModelEffort { readonly id: string; readonly name: string; readonly description?: string }
export interface SessionModelEntry { readonly id: string; readonly name: string; readonly efforts?: SessionModelEffort[] }
export interface SessionModelGroup { readonly id: string; readonly name: string; readonly models: SessionModelEntry[] }
export interface SessionModelDirectory {
  readonly current: SessionModelSelection | null
  readonly routable: boolean
  readonly groups: SessionModelGroup[]
  readonly failures: Array<{ id: string; name: string; message: string }>
}

export interface MaintenanceJobView {
  readonly jobId: string
  readonly agentId: string
  readonly kind: 'checkpoint' | 'compaction'
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly summary: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface SessionEventView {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly payload: Record<string, unknown>
}

const PROVIDER_OUTPUT_LIMIT = 1024 * 1024

/** Credential-free URL provider. Redirects are rejected to avoid leaking keys. */
async function localFetch(input: { url: string; signal?: AbortSignal }): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(input.url, { redirect: 'manual', ...(input.signal === undefined ? {} : { signal: input.signal }) })
  if (response.status >= 300 && response.status < 400) throw new Error('网络重定向已拒绝')
  const body = (await response.text()).slice(0, PROVIDER_OUTPUT_LIMIT)
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
}

/** Credential-free web search provider. It is deliberately small and
 * redirect-free; deployments can replace it with a first-party search API. */
async function localWebSearch(input: { query: string; signal?: AbortSignal }): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`
  const response = await fetch(endpoint, { redirect: 'manual', ...(input.signal === undefined ? {} : { signal: input.signal }) })
  if (response.status >= 300 && response.status < 400) throw new Error('网络重定向已拒绝')
  if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`)
  const html = (await response.text()).slice(0, PROVIDER_OUTPUT_LIMIT * 2)
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(pattern)) {
    const strip = (value: string): string => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
    results.push({ title: strip(match[2] ?? ''), url: match[1] ?? '', snippet: strip(match[3] ?? '') })
    if (results.length >= 10) break
  }
  return results
}

// Local subprocess execution is intentionally not registered by default:
// without an isolation Provider run_command must surface degraded instead of
// silently executing with the Host user's privileges.
const localToolProviders: ToolProviders = { fetch: localFetch, webSearch: localWebSearch }

function deprecatedModel(model: string): boolean {
  return model === 'deepseek-chat' || model === 'deepseek-reasoner'
}

async function ensureSessionModel(workspaceRoot: string, courseId: string, sessionId: string): Promise<SessionModelSelection | null> {
  const historyDir = join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history')
  const eventStore = new SessionEventStore(historyDir)
  const eventModel = (await eventStore.load(sessionId).catch(() => []))
    .reverse()
    .filter(row => row.type === 'session/model' || row.type === 'request/header' || row.type === 'model/provenance')
    .map(row => ({ provider: row.payload['provider'], model: row.payload['model'], effort: row.payload['effort'] }))
    .find(row => typeof row.provider === 'string' && row.provider !== '' && typeof row.model === 'string' && row.model !== '')
  if (eventModel !== undefined) return {
    provider: eventModel.provider as string,
    model: eventModel.model as string,
    ...(typeof eventModel.effort === 'string' && eventModel.effort !== '' ? { effort: eventModel.effort } : {}),
  }
  // Legacy JSONL remains a migration fallback only. Once an event log exists,
  // its model provenance is the durable source of truth for the session.
  const store = new SessionStore(historyDir)
  const existing = await store.latestModel(sessionId).catch(() => null)
  if (existing !== null) return { provider: existing.provider, model: existing.model, ...(existing.effort === undefined ? {} : { effort: existing.effort }) }
  const config = await loadChatConfig(workspaceRoot)
  if (config.providerId === '' || config.model === '' || deprecatedModel(config.model)) return null
  if (await eventStore.exists(sessionId)) {
    await eventStore.append(sessionId, { ts: utcTs(), type: 'session/model', payload: { provider: config.providerId, model: config.model } })
  } else {
    await store.append(sessionId, sessionModelLine.parse({ type: 'session_model', ts: utcTs(), provider: config.providerId, model: config.model }))
  }
  return { provider: config.providerId, model: config.model }
}

export async function sessionModels(workspaceRoot: string, courseId: string, sessionId: string): Promise<SessionModelDirectory> {
  const current = await ensureSessionModel(workspaceRoot, courseId, sessionId)
  const payload = await settingsPayload(workspaceRoot)
  const groups: SessionModelGroup[] = []
  const failures: Array<{ id: string; name: string; message: string }> = []
  const discovered = await Promise.all(payload.providers.map(async (provider) => {
    if (provider.models.length > 0 || provider.baseUrl === null || provider.baseUrl === '' || !provider.apiKeyConfigured) return { provider, models: [] as SessionModelEntry[] }
    try {
      const config = await loadChatConfig(workspaceRoot, { providerId: provider.id })
      const models = await discoverModels({ baseUrl: provider.baseUrl, apiKey: config.apiKey, apiKeyEnv: provider.apiKeyEnv })
      return { provider, models: models.filter(model => model.id !== '' && !deprecatedModel(model.id)).map(model => ({ id: model.id, name: model.name || model.id })) }
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name || provider.id, message: error instanceof Error ? error.message : String(error) })
      return { provider, models: [] as SessionModelEntry[] }
    }
  }))
  for (const { provider, models: discoveredModels } of discovered) {
    const models = provider.models.filter(model => model.id !== '' && !deprecatedModel(model.id)).map(model => ({ id: model.id, name: model.name || model.id }))
    const selected = models.length > 0 ? models : discoveredModels.length > 0 ? discoveredModels : provider.model !== '' && !deprecatedModel(provider.model) ? [{ id: provider.model, name: provider.model }] : []
    // 只展示「可用」路由：未配 Key 的供应商（如残留的 mock）不该出现在
    // 选模目录里诱导用户选中死路由；配置入口在设置页。
    if (selected.length > 0 && provider.apiKeyConfigured) {
      const config = await loadChatConfig(workspaceRoot, { providerId: provider.id }).catch(() => null)
      const enriched = await Promise.all(selected.map(async model => {
        if (config === null) return model
        const efforts = await reasoningEffortsForConfig(config, model.id).catch(() => [])
        return efforts.length === 0 ? model : { ...model, efforts }
      }))
      groups.push({ id: provider.id, name: provider.name || provider.id, models: enriched })
    }
  }
  if (payload.llm.provider !== '' && payload.llm.model !== '' && !deprecatedModel(payload.llm.model) && !groups.some(group => group.id === payload.llm.provider)) {
    groups.push({ id: payload.llm.provider, name: payload.llm.provider, models: [{ id: payload.llm.model, name: payload.llm.model }] })
  }
  const profile = current === null ? undefined : payload.providers.find(item => item.id === current.provider)
  const legacyRoutable = current !== null && current.provider === payload.llm.provider && payload.llm.apiKeyConfigured
  const routable = current !== null && (profile?.apiKeyConfigured === true || legacyRoutable) && groups.some(group => group.id === current.provider && group.models.some(model => model.id === current.model))
  return { current, routable, groups, failures }
}

export async function selectSessionModel(workspaceRoot: string, courseId: string, sessionId: string, selection: SessionModelSelection): Promise<SessionModelSelection> {
  const directory = await sessionModels(workspaceRoot, courseId, sessionId)
  const group = directory.groups.find(item => item.id === selection.provider)
  const model = group?.models.find(item => item.id === selection.model)
  if (model === undefined) throw new SessionError(`模型不可用: ${selection.provider}/${selection.model}`)
  if (selection.effort !== undefined && selection.effort !== null && !(model.efforts ?? []).some(effort => effort.id === selection.effort)) {
    throw new SessionError(`思考强度不可用: ${selection.provider}/${selection.model}/${selection.effort}`)
  }
  const payload = await settingsPayload(workspaceRoot)
  const target = payload.providers.find(item => item.id === selection.provider)
  if (target?.apiKeyConfigured !== true) throw new SessionError(`Provider 未配置凭据: ${selection.provider}`)
  // 首次选择即成为默认模型：会话内选过模型却让 /build 一直读到「未设置默认
  // 模型」是最常见的配置落差（合并语义保留其余字段，失败静默不影响选模）。
  if (target !== undefined && target.model === '') {
    await saveProvider(workspaceRoot, {
      id: target.id,
      name: target.name,
      model: selection.model,
      baseUrl: target.baseUrl,
      overwrite: true,
    }).catch(() => undefined)
  }
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const events = new SessionEventStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  if (await events.exists(sessionId)) {
    await events.append(sessionId, { ts: utcTs(), type: 'session/model', payload: { provider: selection.provider, model: selection.model, ...(selection.effort === undefined || selection.effort === null ? {} : { effort: selection.effort }) } })
  } else {
    await store.append(sessionId, sessionModelLine.parse({ type: 'session_model', ts: utcTs(), provider: selection.provider, model: selection.model, ...(selection.effort === undefined || selection.effort === null ? {} : { effort: selection.effort }) }))
  }
  return selection
}

export async function sessionEvents(workspaceRoot: string, courseId: string, sessionId: string, afterSeq = 0): Promise<{ events: SessionEventView[]; lastSeq: number }> {
  const events = new SessionEventStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const rows = await events.loadAfter(sessionId, afterSeq)
  return { events: rows, lastSeq: rows.at(-1)?.seq ?? afterSeq }
}

export async function sessionProjection(workspaceRoot: string, courseId: string, sessionId: string): Promise<SessionProjection> {
  return new SessionEventStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history')).project(sessionId)
}

export interface LearningAgentOptions {
  readonly workspaceRoot: string
  readonly courseId: string
  readonly sessionId: string
  readonly mode?: LearningMode
  readonly conceptId?: string | null
  readonly inputConfig?: ResolvedChatConfig | null
  readonly approvals?: ApprovalQueue
  readonly agentRegistry?: AgentRegistry
  readonly agentId?: string
  readonly parentAgentId?: string
  /** Immutable DSH-style runtime snapshot captured at Agent creation. */
  readonly runtimeConfig?: AgentRuntimeConfig
  /** Session selection captured at Agent creation; later turns may update it. */
  readonly modelSelection?: AgentModelSelection | null
}

export interface AgentRuntimeConfig {
  readonly agentPreset: string
  readonly permissionPreset: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly plugins: Record<string, boolean>
}

function runtimeConfigOf(config: ResolvedChatConfig): AgentRuntimeConfig {
  return {
    agentPreset: config.agentPreset === 'general' ? 'general' : 'studyclaw-learning',
    permissionPreset: config.permissionPreset === 'read-only' || config.permissionPreset === 'danger-full-access' ? config.permissionPreset : 'workspace-write',
    plugins: Object.fromEntries(Object.entries(config.plugins ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')),
  }
}

const runtimeConfigLocks = new Map<string, Promise<AgentRuntimeConfig>>()

/** Persist one immutable runtime snapshot; concurrent callers are idempotent. */
async function ensureAgentRuntimeConfig(events: SessionEventStore, sessionId: string, config: ResolvedChatConfig): Promise<AgentRuntimeConfig> {
  const key = events.pathFor(sessionId)
  const existingLock = runtimeConfigLocks.get(key)
  if (existingLock !== undefined) return existingLock
  const pending = (async (): Promise<AgentRuntimeConfig> => {
    const current = (await events.project(sessionId).catch(() => null))?.agentConfig
    if (current !== null && current !== undefined) return current
    const snapshot = runtimeConfigOf(config)
    await events.append(sessionId, { ts: utcTs(), type: 'agent/config', payload: { ...snapshot } })
    return snapshot
  })()
  runtimeConfigLocks.set(key, pending)
  try {
    return await pending
  } finally {
    if (runtimeConfigLocks.get(key) === pending) runtimeConfigLocks.delete(key)
  }
}

/** Build one live learning Agent. All callers (Host, Web, CLI and ACP) use this adapter. */
export function createLearningAgent(options: LearningAgentOptions): AgentLoop {
  const courseDir = courseDirOf(options.workspaceRoot, options.courseId)
  const events = new SessionEventStore(join(stateDirOf(courseDir), 'history'))
  const providers: ToolProviders = {
    ...localToolProviders,
    ...(options.agentRegistry === undefined ? {} : {
      subagent: async (input: { task: string; cwd: string; signal?: AbortSignal }) => {
        if (input.signal?.aborted) throw new Error('subagent cancelled')
        const childSessionId = `${options.sessionId}-child-${Date.now().toString(36)}`
        const child = createLearningAgent({
          ...options,
          sessionId: childSessionId,
          agentId: `study-${childSessionId}`,
          parentAgentId: options.agentId ?? `study-${options.sessionId}`,
          mode: 'debug',
        })
        options.agentRegistry!.register(child)
        const parentAgentId = options.agentId ?? `study-${options.sessionId}`
        await child.options.events.append(childSessionId, { ts: utcTs(), type: 'session/create', payload: { mode: 'debug', parentAgentId, parentSessionId: options.sessionId } })
        await events.append(options.sessionId, { ts: utcTs(), type: 'agent/child', payload: { childAgentId: child.options.agentId, childSessionId, parentAgentId } })
        child.send({ content: input.task, metadata: { mode: 'debug', parentAgentId: options.agentId ?? `study-${options.sessionId}` } })
        return { agentId: child.options.agentId, status: 'queued', summary: `子 Agent ${child.options.agentId} 已排队` }
      },
    }),
  }
  const capabilities: AgentCapability[] = [
    { id: 'sandbox', available: providers.sandbox !== undefined, reason: providers.sandbox === undefined ? '未注入隔离执行 Provider' : null, installAction: providers.sandbox === undefined ? '配置 E2B/sandbox Provider' : null },
    { id: 'subprocess', available: providers.subprocess !== undefined, reason: providers.subprocess === undefined ? '未注入本机或隔离 subprocess Provider' : null, installAction: providers.subprocess === undefined ? '配置隔离执行 Provider' : null },
    { id: 'network', available: providers.fetch !== undefined && providers.webSearch !== undefined, reason: null, installAction: null },
    { id: 'lsp', available: providers.lsp !== undefined, reason: providers.lsp === undefined ? '未安装 LSP Provider' : null, installAction: providers.lsp === undefined ? '安装并配置 LSP Provider' : null },
    { id: 'subagent', available: providers.subagent !== undefined, reason: providers.subagent === undefined ? '当前 Host 未启用子 Agent Provider' : null, installAction: providers.subagent === undefined ? '启用 Agent registry' : null },
  ]
  const preset: AgentPreset = {
    id: options.runtimeConfig?.agentPreset === 'general' ? 'general' : 'studyclaw-learning',
    label: options.runtimeConfig?.agentPreset === 'general' ? 'General Agent' : 'StudyClaw Learning Tutor',
    systemPrompt: options.runtimeConfig?.agentPreset === 'general'
      ? 'You are the StudyClaw general agent. Use the available tools deliberately and explain outcomes clearly.'
      : 'You are the StudyClaw learning agent. Guide the learner with evidence from the active course and preserve their agency.',
  }
  return new AgentLoop({
    agentId: options.agentId ?? `study-${options.sessionId}`,
    sessionId: options.sessionId,
    ...(options.parentAgentId === undefined ? {} : { parentAgentId: options.parentAgentId }),
    events,
    cwd: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    courseId: options.courseId,
    capabilities,
    preset,
    ...(options.runtimeConfig?.permissionPreset === undefined ? {} : { permissionPreset: options.runtimeConfig.permissionPreset }),
    ...(preset.systemPrompt === undefined ? {} : { systemPrompt: preset.systemPrompt }),
    modelSelection: options.modelSelection ?? null,
    runner: async function* (turn, context) {
      // Tool/plugin injections are parked by Agent until a model boundary.
      // Fold them into the model-visible prompt while keeping the durable
      // user/input transcript focused on the user's actual turn.
      const injectedContext = context.inbox.injected
        .map(item => item.content.trim())
        .filter(content => content !== '')
      const modelInput = injectedContext.length === 0
        ? turn.content
        : `${turn.content}\n\n[Agent context]\n${injectedContext.join('\n\n')}`
      const metadata = turn.metadata ?? {}
      const mode = (typeof metadata['mode'] === 'string' ? metadata['mode'] : options.mode ?? 'socratic') as LearningMode
      const conceptId = typeof metadata['conceptId'] === 'string' ? metadata['conceptId'] : options.conceptId ?? null
      const selectedEffort = context.modelSelection?.effort ?? null
      const effort = selectedEffort ?? (typeof metadata['effort'] === 'string' ? metadata['effort'] : null)
      const requestId = typeof metadata['requestId'] === 'string' ? metadata['requestId'] : null
      const fileRefs = Array.isArray(metadata['fileRefs']) ? metadata['fileRefs'].filter((value): value is string => typeof value === 'string') : []
      const selection = context.modelSelection ?? await ensureSessionModel(options.workspaceRoot, options.courseId, options.sessionId)
      const selectedConfig = selection !== null
        && options.inputConfig !== null
        && options.inputConfig !== undefined
        && options.inputConfig.providerId === selection.provider
        && options.inputConfig.model === selection.model
        ? options.inputConfig
        : selection === null
          ? options.inputConfig ?? await loadChatConfig(options.workspaceRoot)
          : await loadChatConfig(options.workspaceRoot, { providerId: selection.provider, model: selection.model })
      const config: ResolvedChatConfig = {
        ...(options.runtimeConfig === undefined ? selectedConfig : { ...selectedConfig, ...options.runtimeConfig }),
        reasoningEffort: effort,
      }
      {
        const problem = configProblem(config)
        if (problem !== '') throw new SessionError(problem)
      }
      if (config.apiKey === null) {
        throw new SessionError(`供应商 ${config.providerId || '（未配置）'} 的 API Key 未配置：请在 设置 → 模型配置 中填入`)
      }
      await events.append(options.sessionId, { ts: utcTs(), type: 'request/header', payload: { provider: config.providerId, model: config.model, mode, ...(effort === null ? {} : { effort }), ...(requestId === null ? {} : { requestId }) } })
      yield { type: 'session/meta', payload: { sessionId: options.sessionId, provider: config.providerId, model: config.model, mode, ...(effort === null ? {} : { effort }), ...(requestId === null ? {} : { requestId }) } }
      const courseService = createCourseService(async () => config)
      const toolActions = createToolActions(courseService)
      const approval = options.approvals === undefined
        ? undefined
        : async (request: { name: string; policy: string; args: Record<string, unknown> }): Promise<'allow' | 'deny'> => {
            const permissionPreset = config.permissionPreset ?? 'workspace-write'
            if (request.policy !== 'interactive' && permissionPreset === 'read-only') return 'deny'
            if (request.policy !== 'interactive' && permissionPreset === 'danger-full-access') return 'allow'
            const pending = options.approvals!.request({
              agentId: context.agentId,
              sessionId: context.sessionId,
              name: request.name,
              policy: request.policy,
              args: publicToolArgs(request.name, request.args),
            })
            await events.append(options.sessionId, {
              ts: utcTs(),
              type: 'approval/pending',
              payload: {
                requestId: pending.request.id,
                name: request.name,
                policy: request.policy,
                args: publicToolArgs(request.name, request.args),
                agentId: pending.request.agentId,
                sessionId: pending.request.sessionId,
                createdAt: pending.request.createdAt,
                expiresAt: pending.request.expiresAt,
              },
            })
            const decision = await pending.decision
            return decision === 'allow' ? 'allow' : 'deny'
          }
      const session = new TutorSession(courseDir, options.workspaceRoot, {
        sessionId: options.sessionId,
        mode,
        conceptId,
        persistLegacy: false,
        eventStore: events,
        toolRegistry: agentToolRegistry(courseDir, options.workspaceRoot),
        toolActions,
        providers,
        systemPrompt: context.runtime.systemPrompt,
        toolMode: context.runtime.preset.id === 'general' ? 'general' : mode,
        ...(approval === undefined ? {} : { approval }),
        toolClientFactory: () => createDeepSeekToolClient(config),
      })
      await session.init()
      const fileContext = await fileContextOf(courseDir, fileRefs)
      let assistant = ''
      for await (const event of session.chatEvents(modelInput, mode, fileContext, context.signal)) {
        if (context.signal.aborted) return
        if (event.kind === 'thinking') yield { type: 'assistant/reasoning', payload: { delta: event.delta } }
        else if (event.kind === 'token') { assistant += event.delta; yield { type: 'assistant/chunk', payload: { delta: event.delta } }
        } else if (event.kind === 'tool-start') yield { type: 'tool/call', payload: event.payload }
        else if (event.kind === 'tool') yield { type: 'tool/result', payload: event.payload }
        else if (event.kind === 'ask') yield { type: 'ask/pending', payload: { question: event.question } }
        else if (event.kind === 'sync') yield { type: 'sync/applied', payload: event.payload }
      }
      if (assistant !== '') yield { type: 'assistant/message', payload: { content: assistant, provider: config.providerId, model: config.model } }
    },
  })
}

/** Host-side lifecycle facade. It owns live Agent instances and approval state. */
export class LearningAgentService {
  private readonly answerHandles = new Map<string, AgentTurnHandle>()
  private readonly queuedHandles = new Map<string, AgentTurnHandle>()
  private readonly queuedConsumers = new Set<string>()
  private readonly maintenanceRuns = new Map<string, Promise<void>>()

  constructor(readonly registry: AgentRegistry, readonly approvals = new ApprovalQueue()) {
    this.approvals.onResolved((request, decision) => {
      // Explicit allow/deny is persisted by resolveApproval before the
      // promise is released. The queue callback owns timeout/cancel paths.
      if (decision === 'allow' || decision === 'deny') return
      return this.persistApprovalResolution(request, decision)
    })
  }

  private async persistApprovalResolution(request: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    const historyDir = this.agentCourseHistory(request.agentId, request.sessionId)
    if (historyDir === '') return
    await new SessionEventStore(historyDir).append(request.sessionId, {
      ts: utcTs(),
      type: 'approval/resolved',
      payload: { requestId: request.id, decision },
    }).catch(() => undefined)
  }

  /** Rehydrate pending approvals from the append-only event log on resume. */
  private async restoreApprovals(agent: AgentLoop): Promise<void> {
    const pending = new Map<string, Record<string, unknown>>()
    for (const row of await agent.options.events.load(agent.options.sessionId)) {
      if (row.type === 'approval/pending') {
        const requestId = typeof row.payload['requestId'] === 'string' ? row.payload['requestId'] : ''
        if (requestId !== '') pending.set(requestId, row.payload)
      } else if (row.type === 'approval/resolved') {
        const requestId = typeof row.payload['requestId'] === 'string' ? row.payload['requestId'] : ''
        if (requestId !== '') pending.delete(requestId)
      }
    }
    for (const [requestId, payload] of pending) {
      const createdAt = typeof payload['createdAt'] === 'string' ? payload['createdAt'] : utcTs()
      const expiresAt = typeof payload['expiresAt'] === 'string'
        ? payload['expiresAt']
        : new Date(Date.parse(createdAt) + 5 * 60_000).toISOString()
      this.approvals.restore({
        id: requestId,
        agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : agent.options.agentId,
        sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'] : agent.options.sessionId,
        name: String(payload['name'] ?? ''),
        policy: String(payload['policy'] ?? ''),
        args: typeof payload['args'] === 'object' && payload['args'] !== null ? payload['args'] as Record<string, unknown> : {},
        createdAt,
        expiresAt,
      })
    }
  }

  async create(workspaceRoot: string, courseId: string, mode: string, title: string | null): Promise<{ agentId: string; sessionId: string; status: Record<string, unknown> }> {
    const created = await createSession(workspaceRoot, courseId, mode as LearningMode, title)
    return this.register(workspaceRoot, courseId, created.sessionId, mode as LearningMode)
  }

  /**
   * Rehydrate only sessions that still own durable work after a Host restart.
   * DSH keeps idle sessions cold; queued/interrupted turns and human
   * interaction gates are the restart boundary that must be made live again.
   */
  async recover(workspaceRoot: string): Promise<Array<Record<string, unknown>>> {
    if (workspaceRoot.trim() === '') return []
    const recovered: Array<Record<string, unknown>> = []
    // 项目即课程：会话历史直接位于项目根 history/。
    const historyDir = join(stateDirOf(workspaceRoot), 'history')
    const projectId = basename(workspaceRoot)
    const files = await readdir(historyDir, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      const match = /^session_(.+)\.events\.jsonl$/.exec(file.name)
      if (!file.isFile() || match === null) continue
      const sessionId = match[1]!
      const events = new SessionEventStore(historyDir)
        const rows = await events.load(sessionId).catch(() => [])
        if (rows.length === 0) continue
        const pendingTurns = new Set<string>()
        const dequeued = new Set<string>()
        for (const row of rows) {
          const turnId = typeof row.payload['turnId'] === 'string' ? row.payload['turnId'] : ''
          if (turnId === '') continue
          if (row.type === 'inbox/queued') pendingTurns.add(turnId)
          else if (row.type === 'inbox/dequeued') { pendingTurns.delete(turnId); dequeued.add(turnId) }
          else if (row.type === 'inbox/dropped' || row.type === 'turn/end' || row.type === 'turn/error' || row.type === 'turn/cancelled') {
            pendingTurns.delete(turnId)
            dequeued.delete(turnId)
          }
        }
        const projection = await events.project(sessionId).catch(() => null)
        const needsRecovery = projection?.phase !== 'disposed' && (pendingTurns.size > 0 || dequeued.size > 0
          || (projection !== null && projection !== undefined && (projection.pendingAsk !== null || projection.pendingApprovals.length > 0))
          || (projection !== null && projection !== undefined && projection.maintenanceJobs.some(job => job.status === 'queued' || job.status === 'running'))
        )
        if (!needsRecovery || this.registry.get(`study-${sessionId}`) !== undefined) continue
        const meta = await new SessionStore(historyDir).readMeta(sessionId).catch(() => null)
        const mode = meta?.mode ?? rows.find(row => ['socratic', 'quick', 'feynman', 'debug'].includes(String(row.payload['mode'] ?? '')))?.payload['mode'] as LearningMode | undefined ?? 'socratic'
        try {
          recovered.push(await this.register(workspaceRoot, projectId, sessionId, mode))
        } catch {
          // A malformed or no-longer-routable session remains visible and can
          // be resumed explicitly after the user repairs its configuration.
        }
    }
    return recovered
  }

  async resume(workspaceRoot: string, courseId: string, sessionId: string): Promise<{ agentId: string; sessionId: string; status: Record<string, unknown> }> {
    const restored = await restoreSession(workspaceRoot, courseId, sessionId)
    return this.register(workspaceRoot, courseId, sessionId, restored.mode as LearningMode)
  }

  async register(workspaceRoot: string, courseId: string, sessionId: string, mode: LearningMode): Promise<{ agentId: string; sessionId: string; status: Record<string, unknown> }> {
    const agentId = `study-${sessionId}`
    const existing = this.registry.get(agentId)
    let runtimeConfig: AgentRuntimeConfig | undefined
    if (existing === undefined) {
      const historyDir = join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history')
      const events = new SessionEventStore(historyDir)
      if (!(await events.exists(sessionId))) {
        const meta = await new SessionStore(historyDir).readMeta(sessionId)
        await events.append(sessionId, { ts: utcTs(), type: 'session/create', payload: { mode, agentId, ...(meta?.title ? { title: meta.title } : {}) } })
      }
      runtimeConfig = await ensureAgentRuntimeConfig(events, sessionId, await loadChatConfig(workspaceRoot))
    }
    const modelSelection = await ensureSessionModel(workspaceRoot, courseId, sessionId)
    const agent = existing ?? createLearningAgent({ workspaceRoot, courseId, sessionId, mode, approvals: this.approvals, agentRegistry: this.registry, modelSelection, ...(runtimeConfig === undefined ? {} : { runtimeConfig }) })
    if (existing === undefined) {
      this.registry.register(agent)
    }
    await agent.restore()
    await this.restoreApprovals(agent)
    await this.restoreMaintenance(agent)
    return { agentId, sessionId, status: agent.status as unknown as Record<string, unknown> }
  }

  /** Apply a persisted session model to the live Agent without appending a
   * duplicate event. Cold sessions pick the persisted selection on resume. */
  async selectModel(sessionId: string, selection: SessionModelSelection): Promise<SessionModelSelection> {
    const agent = this.registry.get(`study-${sessionId}`)
    if (agent !== undefined) await this.registry.selectModel(agent.options.agentId, selection, false)
    return selection
  }

  status(agentId: string): Record<string, unknown> { return this.registry.status(agentId) as unknown as Record<string, unknown> }
  list(): Array<Record<string, unknown>> { return this.registry.list() as unknown as Array<Record<string, unknown>> }
  /** Answer a durable ask-user question and enqueue the resumed turn. */
  async answer(agentId: string, answer: string): Promise<Record<string, unknown>> {
    const text = answer.trim()
    if (text === '') throw new SessionError('回答不能为空')
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    const projection = await agent.projection()
    if (projection.pendingAsk === null) throw new SessionError('当前没有待回答的问题')
    const handle = agent.send({ content: text, metadata: { resumeAsk: true } })
    // Keep the exact turn stream available to the SSE answer transport. A
    // unary RPC cannot carry the resumed assistant chunks itself.
    this.answerHandles.set(handle.turnId, handle)
    return { ...agent.status, turnId: handle.turnId }
  }

  /** Persist an inbox message immediately for durable Web/CLI queueing. */
  async send(workspaceRoot: string, courseId: string, sessionId: string, mode: LearningMode, content: string, metadata: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const registered = await this.register(workspaceRoot, courseId, sessionId, mode)
    const agent = this.registry.get(registered.agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${registered.agentId}`)
    const handle = agent.send({ content, mode, metadata })
    this.queuedHandles.set(handle.turnId, handle)
    return { agentId: registered.agentId, sessionId, turnId: handle.turnId, status: agent.status }
  }

  async *queuedEvents(agentId: string, turnId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (this.queuedConsumers.has(turnId)) throw new SessionError(`队列回合已被消费: ${turnId}`)
    const handle = this.queuedHandles.get(turnId) ?? this.registry.get(agentId)?.attach(turnId)
    if (handle === undefined) throw new SessionError(`队列回合不存在: ${turnId}`)
    this.queuedConsumers.add(turnId)
    this.queuedHandles.delete(turnId)
    try {
      for await (const event of handle.events) {
        if (signal?.aborted) break
        yield event
      }
    } finally {
      this.queuedConsumers.delete(turnId)
      if (signal?.aborted) {
        this.registry.get(agentId)?.cancel({ keepInbox: true, cause: 'system' })
      }
    }
  }

  /** Consume the stream created by a preceding `agents.answer` call. */
  async *answerEvents(agentId: string, turnId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const handle = this.answerHandles.get(turnId)
    if (handle === undefined) throw new SessionError(`回答回合不存在: ${turnId}`)
    this.answerHandles.delete(turnId)
    try {
      for await (const event of handle.events) {
        if (signal?.aborted) break
        yield event
      }
    } finally {
      if (signal?.aborted) this.registry.get(agentId)?.cancel({ keepInbox: true, cause: 'system' })
    }
  }
  async cancel(agentId: string, keepInbox = false): Promise<Record<string, unknown>> {
    this.approvals.cancelForAgent(agentId)
    return await this.registry.cancel(agentId, keepInbox) as unknown as Record<string, unknown>
  }
  async whenIdle(agentId: string): Promise<Record<string, unknown>> { return await this.registry.whenIdle(agentId) as unknown as Record<string, unknown> }
  async maintenance(agentId: string, kind: 'checkpoint' | 'compaction' = 'checkpoint', summary: string | null = null): Promise<MaintenanceJobView> {
    if (kind !== 'checkpoint' && kind !== 'compaction') throw new SessionError(`不支持的维护任务: ${kind}`)
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    const projection = await agent.projection()
    const existing = projection.maintenanceJobs.find(job => job.status === 'queued' || job.status === 'running')
    if (existing !== undefined) return existing
    const job: MaintenanceJobView = {
      jobId: `maint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      kind,
      status: 'queued',
      summary: summary === null ? null : summary.slice(0, 8_000),
      error: null,
      createdAt: utcTs(),
      startedAt: null,
      finishedAt: null,
    }
    await agent.options.events.append(agent.options.sessionId, {
      ts: job.createdAt,
      type: 'maintenance/queued',
      payload: { jobId: job.jobId, agentId, kind, summary: job.summary },
    })
    this.startMaintenance(agent, job)
    return job
  }
  async maintenanceJobs(agentId: string): Promise<MaintenanceJobView[]> {
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    return (await agent.projection()).maintenanceJobs
  }

  private startMaintenance(agent: AgentLoop, job: MaintenanceJobView): void {
    if (this.maintenanceRuns.has(job.jobId)) return
    const run = this.runMaintenance(agent, job).finally(() => this.maintenanceRuns.delete(job.jobId))
    this.maintenanceRuns.set(job.jobId, run)
  }

  private async runMaintenance(agent: AgentLoop, job: MaintenanceJobView): Promise<void> {
    try {
      await agent.whenIdle()
      const current = await agent.projection()
      if (current.pendingAsk !== null || current.pendingApprovals.length > 0) throw new Error('Agent 正在等待用户交互')
      await agent.runMaintenance(async () => {
        await agent.options.events.append(agent.options.sessionId, {
          ts: utcTs(),
          type: 'maintenance/start',
          payload: { jobId: job.jobId, agentId: job.agentId, kind: job.kind, summary: job.summary },
        })
        try {
          if (job.kind === 'compaction') {
            const row = await agent.options.events.append(agent.options.sessionId, {
              ts: utcTs(),
              type: 'compaction/applied',
              payload: { jobId: job.jobId, summary: job.summary },
            })
            await agent.options.events.append(agent.options.sessionId, {
              ts: utcTs(),
              type: 'maintenance/end',
              payload: { jobId: job.jobId, agentId: job.agentId, kind: job.kind, lastSeq: row[0]?.seq ?? null },
            })
          } else {
            const projection = await agent.projection()
            await agent.options.events.append(agent.options.sessionId, {
              ts: utcTs(),
              type: 'maintenance/end',
              payload: { jobId: job.jobId, agentId: job.agentId, kind: job.kind, lastSeq: projection.lastSeq },
            })
          }
        } catch (error) {
          throw error
        }
      })
    } catch (error) {
      await agent.options.events.append(agent.options.sessionId, {
        ts: utcTs(),
        type: 'maintenance/error',
        payload: { jobId: job.jobId, agentId: job.agentId, kind: job.kind, message: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined)
    }
  }

  private async restoreMaintenance(agent: AgentLoop): Promise<void> {
    const projection = await agent.projection().catch(() => null)
    if (projection === null) return
    for (const job of projection.maintenanceJobs) {
      if (job.status === 'queued' || job.status === 'running') this.startMaintenance(agent, job)
    }
  }
  async dispose(agentId: string): Promise<Record<string, unknown>> {
    this.approvals.cancelForAgent(agentId)
    await this.registry.dispose(agentId)
    return { agentId, phase: 'disposed', queued: 0, activeTurnId: null }
  }
  async projection(agentId: string): Promise<SessionProjection> {
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    return agent.projection()
  }
  async updatePlan(agentId: string, steps: Array<Record<string, unknown>>): Promise<SessionProjection['plan']> {
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    await agent.options.events.append(agent.options.sessionId, { ts: utcTs(), type: 'plan/update', payload: { steps } })
    return (await agent.projection()).plan
  }
  async updateTodos(agentId: string, items: Array<Record<string, unknown>>): Promise<SessionProjection['todos']> {
    const agent = this.registry.get(agentId)
    if (agent === undefined) throw new SessionError(`Agent 不存在: ${agentId}`)
    await agent.options.events.append(agent.options.sessionId, { ts: utcTs(), type: 'todo/update', payload: { items } })
    return (await agent.projection()).todos
  }
  listApprovals(agentId?: string): ReturnType<ApprovalQueue['list']> { return this.approvals.list(agentId) }
  async resolveApproval(requestId: string, decision: 'allow' | 'deny' | 'cancel'): Promise<Record<string, unknown>> {
    const pending = this.approvals.list().find(item => item.id === requestId)
    if (pending !== undefined && decision !== 'cancel') await this.persistApprovalResolution(pending, decision)
    const request = this.approvals.resolve(requestId, decision)
    return request as unknown as Record<string, unknown>
  }

  private agentCourseHistory(_agentId: string, sessionId: string): string {
    const agent = this.registry.get(`study-${sessionId}`)
    return agent?.options.events.historyDir ?? ''
  }

}

function courseDirOf(workspaceRoot: string, courseId: string): string {
  if (courseId === '' || /[\/]/.test(courseId) || courseId.includes('..') || courseId.startsWith('.')) {
    throw new SessionError(`课程不存在: ${courseId}`)
  }
  // 项目即课程：courseId = 项目根 basename；不匹配视为课程不存在（避免跨项目串数据）。
  if (courseId !== basename(workspaceRoot)) throw new SessionError(`课程不存在: ${courseId}`)
  return workspaceRoot
}

function toView(summary: Awaited<ReturnType<SessionStore['listSessions']>>[number], turns: number): SessionSummaryView {
  return {
    sessionId: summary.id,
    title: summary.title,
    mode: summary.mode,
    turns,
    createdAt: summary.createdAt,
    lastActiveAt: new Date(summary.mtimeMs).toISOString(),
  }
}

/** List a course's sessions (mtime desc), with chat-line turn counts. */
export async function listSessions(workspaceRoot: string, courseId: string): Promise<SessionSummaryView[]> {
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const eventStore = new SessionEventStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const summaries = await store.listSessions()
  const views: SessionSummaryView[] = []
  for (const summary of summaries) {
    const chats = await store.loadChat(summary.id).catch(() => [])
    const projection = await eventStore.exists(summary.id) ? await eventStore.project(summary.id) : null
    const turns = projection === null ? chats.filter(line => line.role === 'user').length : projection.messages.filter(line => line.role === 'user').length
    views.push(toView(summary, turns))
  }
  return views
}

function excerptFor(content: string, matchAt: number, queryLength: number): string {
  const start = Math.max(0, matchAt - 72)
  const end = Math.min(content.length, matchAt + queryLength + 96)
  const prefix = start === 0 ? '' : '...'
  const suffix = end === content.length ? '' : '...'
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/**
 * Search durable session titles and chat bodies for one course. The caller
 * supplies workspace/course context and applies the global result limit.
 */
export async function searchSessions(
  workspaceRoot: string,
  courseId: string,
  query: string,
): Promise<SessionSearchView[]> {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return []
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const eventStore = new SessionEventStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const matches: SessionSearchView[] = []
  for (const summary of await store.listSessions()) {
    const chats = await store.loadChat(summary.id).catch(() => [])
    const projection = await eventStore.exists(summary.id) ? await eventStore.project(summary.id) : null
    const turns = projection === null ? chats.filter(line => line.role === 'user').length : projection.messages.filter(line => line.role === 'user').length
    const view = toView(summary, turns)
    const searchable = projection === null ? chats.map(line => line.content) : projection.messages.map(line => line.content)
    if (summary.title.toLowerCase().includes(normalized)) {
      matches.push({ ...view, match: 'title' })
      continue
    }
    const chat = searchable.find(content => content.toLowerCase().indexOf(normalized) !== -1)
    if (chat === undefined) continue
    const matchAt = chat.toLowerCase().indexOf(normalized)
    matches.push({
      ...view,
      match: 'content',
      snippet: excerptFor(chat, matchAt, normalized.length),
    })
  }
  return matches
}

/** Create a fresh session (meta line written immediately). */
export async function createSession(
  workspaceRoot: string,
  courseId: string,
  mode: LearningMode,
  title: string | null,
): Promise<{ sessionId: string; file: string }> {
  const courseDir = courseDirOf(workspaceRoot, courseId)
  const store = new SessionStore(join(stateDirOf(courseDir), 'history'))
  const { sessionId, path } = await store.newSession(mode, title)
  const config = await loadChatConfig(workspaceRoot)
  if (config.providerId !== '' && config.model !== '' && !deprecatedModel(config.model)) {
    await store.append(sessionId, sessionModelLine.parse({ type: 'session_model', ts: utcTs(), provider: config.providerId, model: config.model }))
  }
  return { sessionId, file: path }
}

/** Rename a session by updating its metadata title only. */
export async function renameSession(
  workspaceRoot: string,
  courseId: string,
  sessionId: string,
  title: string,
): Promise<{ sessionId: string; title: string }> {
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const normalized = title.trim()
  if (normalized === '') throw new SessionError('会话标题不能为空')
  await store.renameSession(sessionId, normalized)
  return { sessionId, title: normalized }
}

/** Fork a session at an optional persisted chat index. */
export async function forkSession(
  workspaceRoot: string,
  courseId: string,
  sessionId: string,
  chatIndex?: number,
): Promise<{ sessionId: string; file: string }> {
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  const historyDir = join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history')
  const events = new SessionEventStore(historyDir)
  if (await events.exists(sessionId)) {
    const { stat } = await import('node:fs/promises')
    const base = new Date()
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const candidate = new Date(base.getTime() + attempt * 1000)
      const compact = candidate.toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const forkedId = `${compact.slice(0, 8)}-${compact.slice(8)}`
      if (await events.exists(forkedId) || await stat(join(historyDir, `session_${forkedId}.jsonl`)).catch(() => null)) continue
      await events.forkSession(sessionId, forkedId, chatIndex)
      const source = await events.project(sessionId)
      const sourceTitle = source.messages.find(message => message.role === 'user')?.content.slice(0, 20) ?? '未命名会话'
      await events.append(forkedId, { ts: utcTs(), type: 'session/rename', payload: { title: `${sourceTitle}（副本）` } })
      return { sessionId: forkedId, file: events.pathFor(forkedId) }
    }
    throw new SessionError('无法创建会话副本：时间戳冲突')
  }
  const { sessionId: forkedId, path } = await store.forkSession(sessionId, undefined, chatIndex)
  if (await events.exists(sessionId)) await events.forkSession(sessionId, forkedId, chatIndex)
  return { sessionId: forkedId, file: path }
}

/** Archive a session without deleting its durable history. */
export async function archiveSession(
  workspaceRoot: string,
  courseId: string,
  sessionId: string,
): Promise<{ sessionId: string; archived: true }> {
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  await store.archiveSession(sessionId)
  return { sessionId, archived: true }
}

/** Persist a manual session order by inserting one session before another. */
export async function reorderSession(
  workspaceRoot: string,
  courseId: string,
  sessionId: string,
  beforeId?: string,
): Promise<{ sessions: SessionSummaryView[] }> {
  const store = new SessionStore(join(stateDirOf(courseDirOf(workspaceRoot, courseId)), 'history'))
  await store.insertSessionBefore(sessionId, beforeId)
  return { sessions: await listSessions(workspaceRoot, courseId) }
}

/** Restore one session: history turns + suggested entry + pending ask. */
export async function restoreSession(
  workspaceRoot: string,
  courseId: string,
  sessionId: string,
): Promise<RestoredSessionView> {
  const courseDir = courseDirOf(workspaceRoot, courseId)
  const store = new SessionStore(join(stateDirOf(courseDir), 'history'))
  const eventStore = new SessionEventStore(join(stateDirOf(courseDir), 'history'))
  const legacyChats = await store.loadChat(sessionId).catch(() => [])
  const projection = await eventStore.exists(sessionId) ? await eventStore.project(sessionId) : null
  const eventRows = projection === null ? [] : await eventStore.load(sessionId)
  const chats = projection === null
    ? legacyChats
    : projection.messages.map(message => ({ type: 'chat' as const, ts: eventRows.find(row => row.seq === message.seq)?.ts ?? utcTs(), role: message.role === 'user' ? 'user' as const : 'agent' as const, content: message.content }))
  const meta = await store.readMeta(sessionId)
  let title = meta?.title ?? ''
  let mode = meta?.mode ?? 'socratic'
  let userNamed = (meta?.title ?? '') !== ''
  if (projection !== null) {
    for (const row of eventRows) {
      if ((row.type === 'session/meta' || row.type === 'session/create' || row.type === 'session/rename') && typeof row.payload['title'] === 'string' && row.payload['title'].trim() !== '') {
        title = row.payload['title'].trim()
        if (row.type === 'session/rename') userNamed = true
      }
      // Automatic titles apply only when no user rename has pinned the title
      // (same priority as the SessionStore list derivation).
      if (row.type === 'session/title' && !userNamed && typeof row.payload['title'] === 'string' && row.payload['title'].trim() !== '') {
        title = row.payload['title'].trim()
      }
      if ((row.type === 'session/meta' || row.type === 'session/create') && (row.payload['mode'] === 'quick' || row.payload['mode'] === 'feynman' || row.payload['mode'] === 'debug' || row.payload['mode'] === 'socratic')) mode = row.payload['mode']
    }
  }
  let pendingAsk: { question: string } | null = null
  if (projection !== null) {
    pendingAsk = projection.pendingAsk === null ? null : { question: projection.pendingAsk }
  } else {
    for (const row of await store.load(sessionId)) {
      if (row['type'] === 'ask' && row['status'] === 'pending') {
        pendingAsk = { question: String(row['question'] ?? '') }
      }
    }
  }
  const last = chats[chats.length - 1]
  return {
    sessionId,
    title,
    mode,
    restored: true,
    turns: chats.map(line => ({ role: line.role as 'user' | 'agent', ts: line.ts, content: line.content })),
    suggestedEntry: last?.role === 'agent' ? last.content.slice(-120) : null,
    wakeup: null,
    pendingAsk,
  }
}

/** Load the referenced files into a file-context block (best-effort, capped). */
export async function fileContextOf(courseDir: string, fileRefs: string[]): Promise<string | null> {
  if (fileRefs.length === 0) return null
  const parts: string[] = []
  for (const ref of fileRefs.slice(0, 8)) {
    try {
      const path = await resolveSourceRef(courseDir, ref)
      const text = await readFile(path, 'utf8')
      parts.push(`### ${ref}\n${text.slice(0, 4000)}`)
    } catch {
      // Unreadable refs are skipped; the conversation continues.
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}

function courseIdOfAction(ctx: ToolActionContext): string {
  const match = /[\\/]courses[\\/]([^\\/]+)$/.exec(ctx.courseDir)
  return match?.[1] ?? basename(ctx.courseDir)
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function taskMetadata(value: unknown): Record<string, unknown> | null {
  const task = objectOf(value)
  if (task === null) return null
  const output: Record<string, unknown> = {}
  for (const [source, target] of [
    ['task_id', 'taskId'],
    ['concept_id', 'conceptId'],
    ['type', 'type'],
    ['difficulty', 'difficulty'],
    ['dynamic', 'dynamic'],
    ['target_id', 'targetId'],
  ] as const) {
    if (task[source] !== undefined) output[target] = task[source]
  }
  return output
}

function taskMetadataList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.map(taskMetadata).filter((task): task is Record<string, unknown> => task !== null)
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Number(args[key]) : fallback
}

/** Bind the tools package to the existing course/learning service. */
export function createToolActions(courseService: CourseService): ToolActions {
  return {
    async getTaskPool(ctx, args): Promise<ToolHandlerResult> {
      const conceptId = typeof args['conceptId'] === 'string' ? args['conceptId'] : null
      const tasks = await courseService.taskPool(ctx.workspaceRoot, courseIdOfAction(ctx), conceptId, numberArg(args, 'limit', 100))
      const byType: Record<string, number> = {}
      const byDifficulty: Record<string, number> = {}
      const byConcept: Record<string, number> = {}
      for (const task of tasks) {
        const type = String(task['type'] ?? 'unknown')
        const difficulty = String(task['difficulty'] ?? 'unknown')
        const concept = String(task['conceptId'] ?? 'unknown')
        byType[type] = (byType[type] ?? 0) + 1
        byDifficulty[difficulty] = (byDifficulty[difficulty] ?? 0) + 1
        byConcept[concept] = (byConcept[concept] ?? 0) + 1
      }
      return [`题卡池 ${tasks.length} 张`, { count: tasks.length, conceptId, byType, byDifficulty, byConcept }]
    },
    async createCard(ctx, args): Promise<ToolHandlerResult> {
      const result = await courseService.createCards(ctx.workspaceRoot, courseIdOfAction(ctx), {
        content: String(args['content'] ?? ''),
        title: typeof args['title'] === 'string' ? args['title'] : null,
        conceptId: typeof args['conceptId'] === 'string' ? args['conceptId'] : null,
        count: numberArg(args, 'count', 1),
        ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
      })
      const tasks = taskMetadataList(result['tasks'])
      return [`已生成 ${tasks.length} 张复习卡`, { tasks }]
    },
    async generateDynamicCard(ctx, args): Promise<ToolHandlerResult> {
      const result = await courseService.dynamicCards(ctx.workspaceRoot, courseIdOfAction(ctx), {
        taskId: String(args['taskId'] ?? ''),
        misconception: String(args['misconception'] ?? ''),
        content: typeof args['content'] === 'string' ? args['content'] : null,
        targetId: typeof args['targetId'] === 'string' ? args['targetId'] : null,
        count: numberArg(args, 'count', 1),
        ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
      })
      const tasks = taskMetadataList(result['tasks'])
      return [`已生成 ${tasks.length} 张动态卡`, { tasks }]
    },
    async runReview(ctx, args): Promise<ToolHandlerResult> {
      const tasks = await courseService.quiz(
        ctx.workspaceRoot,
        courseIdOfAction(ctx),
        'review',
        numberArg(args, 'count', 1),
        typeof args['conceptId'] === 'string' ? args['conceptId'] : null,
      )
      return [`已准备 ${tasks.length} 道到期复习题`, { tasks }]
    },
    async runQuiz(ctx, args): Promise<ToolHandlerResult> {
      const mode = args['mode'] === 'new' ? 'new' : 'review'
      const tasks = await courseService.quiz(
        ctx.workspaceRoot,
        courseIdOfAction(ctx),
        mode,
        numberArg(args, 'count', 1),
        typeof args['conceptId'] === 'string' ? args['conceptId'] : null,
      )
      return [`已准备 ${tasks.length} 道${mode === 'new' ? '新题' : '复习题'}`, { mode, tasks }]
    },
    async evaluateAnswer(ctx, args): Promise<ToolHandlerResult> {
      let result: Record<string, unknown> | null = null
      for await (const frame of courseService.evalSubmit(
        ctx.workspaceRoot,
        courseIdOfAction(ctx),
        String(args['taskId'] ?? ''),
        String(args['answer'] ?? ''),
        ctx.sessionId,
      )) {
        if (frame['event'] === 'result') result = objectOf(frame['data'])
      }
      if (result === null) throw new Error('评估未返回结果')
      const passed = result['passed'] === true
      const score = typeof result['score'] === 'number' ? result['score'] : null
      const feedback = typeof result['feedback'] === 'string' ? result['feedback'].slice(0, 1200) : ''
      return [`作答${passed ? '通过' : '未通过'}${score === null ? '' : ` · ${Math.round(score * 100)} 分`}`, { passed, score, feedback }]
    },
    async syncSources(ctx): Promise<ToolHandlerResult> {
      const result = await courseService.sync(ctx.workspaceRoot, courseIdOfAction(ctx), ctx.sessionId ?? null)
      const added = Array.isArray(result['added']) ? result['added'].length : 0
      const changed = Array.isArray(result['changed']) ? result['changed'].length : 0
      const skipped = typeof result['skipped'] === 'number' ? result['skipped'] : 0
      return [`资料同步完成 · 新增 ${added} · 变更 ${changed} · 跳过 ${skipped}`, result]
    },
  }
}

/**
 * DSH session-title policy (first-prompt cadence, lightweight rewrite): one
 * tiny completion over the active route names the conversation in ~5 words.
 * The first message travels as a JSON array so its content cannot break the
 * instruction; failures are silent — the synchronous fallback title already
 * covers the sidebar.
 */
async function generateLlmSessionTitle(config: ResolvedChatConfig, firstMessage: string): Promise<string> {
  const system = 'You name chat sessions. Reply with ONLY the session title: about 5 words (at most 10 CJK characters), plain text, no quotes, no trailing punctuation, no markdown.'
  const user = `Name the session opened by this first user message: ${JSON.stringify([firstMessage.slice(0, 4000)])}`
  let raw = ''
  for await (const chunk of createDeepSeekToolClient(config).request(
    system,
    [{ role: 'user', content: user }],
    null,
    AbortSignal.timeout(60_000),
  )) {
    if (chunk.kind === 'text') raw += chunk.delta
  }
  return normalizeSessionTitle(raw.replace(/["'「『」』]/g, ''), 80)
}

/**
 * Run one chat turn over a course: resumes/creates the session as needed,
 * wires the tool registry and the config-backed LLM client, and streams the
 * events. `config` may be null (host without a configured provider) — the
 * resulting stream emits an error event instead of crashing.
 */
export async function* chatStream(
  workspaceRoot: string,
  courseId: string,
  input: {
    sessionId?: string | null
    message: string
    mode?: LearningMode
    effort?: string | null
    requestId?: string | null
    conceptId?: string | null
    fileRefs?: string[]
    signal?: AbortSignal
  },
  inputConfig: ResolvedChatConfig | null,
  agentRegistry?: AgentRegistry,
  approvals?: ApprovalQueue,
): AsyncGenerator<ChatEvent | { kind: 'error'; code: string; message: string } | { kind: 'meta'; payload: Record<string, unknown> }> {
  const courseDir = courseDirOf(workspaceRoot, courseId)
  const session = new TutorSession(courseDir, workspaceRoot, {
    sessionId: input.sessionId ?? null,
    mode: input.mode ?? 'socratic',
    persistLegacy: false,
    eventStore: new SessionEventStore(join(stateDirOf(courseDir), 'history')),
  })
  await session.init()
  const eventStore = new SessionEventStore(join(stateDirOf(courseDir), 'history'))
  if (!(await eventStore.exists(session.sessionId))) {
    await eventStore.append(session.sessionId, { ts: utcTs(), type: 'session/create', payload: { mode: input.mode ?? 'socratic', agentId: `study-${session.sessionId}` } })
  }
  const runtimeConfig = await ensureAgentRuntimeConfig(eventStore, session.sessionId, inputConfig ?? await loadChatConfig(workspaceRoot))
  const modelSelection = await ensureSessionModel(workspaceRoot, courseId, session.sessionId)
  // DSH ensureFallback: the deterministic first-prompt title lands at send
  // time (independent of turn outcome) so the sidebar drops the blank
  // "新对话" placeholder as soon as the first message exists.
  const historyStore = new SessionStore(join(stateDirOf(courseDir), 'history'))
  let firstPrompt = false
  const fallbackTitle = studyclawFallbackTitle(input.message)
  if (fallbackTitle !== '') {
    firstPrompt = await historyStore.applyAutoTitle(session.sessionId, fallbackTitle, 'fallback').catch(() => false)
  }
  const agent = agentRegistry?.get(`study-${session.sessionId}`) ?? createLearningAgent({
    workspaceRoot,
    courseId,
    sessionId: session.sessionId,
    mode: input.mode ?? 'socratic',
    conceptId: input.conceptId ?? null,
    inputConfig,
    modelSelection,
    ...(agentRegistry === undefined ? {} : { agentRegistry }),
    ...(approvals === undefined ? {} : { approvals }),
    runtimeConfig,
  })
  if (agentRegistry?.get(agent.options.agentId) === undefined) {
    agentRegistry?.register(agent)
    await agent.restore()
  }
  const abort = (): void => {
    approvals?.cancelForAgent(agent.options.agentId)
    agent.cancel({ keepInbox: true, cause: 'system' })
  }
  if (input.signal?.aborted) abort()
  else input.signal?.addEventListener('abort', abort, { once: true })
  try {
    const handle = agent.send({
      content: input.message,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      metadata: {
        mode: input.mode ?? 'socratic',
        conceptId: input.conceptId ?? null,
        fileRefs: input.fileRefs ?? [],
        ...(input.effort === undefined || input.effort === null ? {} : { effort: input.effort }),
        ...(input.requestId === undefined || input.requestId === null ? {} : { requestId: input.requestId }),
      },
    })
    for await (const event of handle.events) {
      const payload = event.payload ?? {}
      if (event.type === 'session/meta') yield { kind: 'meta', payload }
      else if (event.type === 'assistant/reasoning') yield { kind: 'thinking', delta: String(payload['delta'] ?? '') }
      else if (event.type === 'assistant/chunk') yield { kind: 'token', delta: String(payload['delta'] ?? '') }
      else if (event.type === 'tool/call') yield { kind: 'tool-start', payload: payload as { callId: string; name: string; args: Record<string, unknown> } }
      else if (event.type === 'tool/result') yield { kind: 'tool', payload }
      else if (event.type === 'ask/pending') yield { kind: 'ask', question: String(payload['question'] ?? '') }
      else if (event.type === 'sync/applied') yield { kind: 'sync', payload }
      else if (event.type === 'turn/error') yield { kind: 'error', code: 'AGENT_TURN_FAILED', message: String(payload['message'] ?? 'Agent turn failed') }
    }
    if (firstPrompt) {
      // DSH first-prompt cadence: the LLM rename runs after the stream so the
      // done frame is not delayed; it only upgrades the fallback written at
      // send time and never overrides a user rename (pin check in store).
      void (async () => {
        const config = modelSelection !== null
          ? await loadChatConfig(workspaceRoot, { providerId: modelSelection.provider, model: modelSelection.model })
          : inputConfig ?? await loadChatConfig(workspaceRoot)
        const title = await generateLlmSessionTitle(config, input.message)
        if (title !== '') {
          await historyStore.applyAutoTitle(session.sessionId, title, 'llm', { provider: config.providerId, model: config.model })
        }
      })().catch(() => undefined)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    yield { kind: 'error', code: message.includes('模型') || message.includes('API Key') ? 'LLM_NOT_CONFIGURED' : 'CHAT_FAILED', message }
  } finally {
    input.signal?.removeEventListener('abort', abort)
  }
}
