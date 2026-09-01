/**
 * StudyClaw RPC contract (M1 minimal method set): unary dispatch over
 * `POST /api/<method>` with a typed payload/result envelope, zod payload
 * validation at the boundary, business-error mapping from registry
 * exceptions to stable codes, and the wire views the web sidebar renders.
 * The dispatch body is transport-agnostic — the CLI server wires it to
 * node:http, an in-process caller can await it directly (dsh's
 * InProcessApiClient equivalent).
 * @module @studyclaw/apiproxy
 */

import { z } from 'zod'
import type { Workspace, WorkspaceId } from '@studyclaw/workspace'
import { WorkspaceNameConflictError, WorkspaceOrderInvalidError } from '@studyclaw/workspace'
import { ProviderExistsError } from '@studyclaw/chat-service'
import type { CourseSummary } from '@studyclaw/course-summary'
import type { SessionSummaryView, RestoredSessionView, SessionModelDirectory, SessionModelSelection, SessionEventView } from '@studyclaw/chat-service'

/** One workspace as the web sidebar sees it. */
export interface WorkspaceView {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** The `workspaces.list` result. */
export interface WorkspacesListResult {
  readonly current: string | null
  readonly items: WorkspaceView[]
}

/** The `workspaces.open` result. */
export interface OpenWorkspaceResult {
  readonly workspace: WorkspaceView
  readonly created: boolean
  /** FL-18：自动建课骨架失败的原因（null = 无警告）。旧实现被静默吞掉。 */
  readonly courseWarning?: string | null
}

/** The `workspaces.courses` result. */
export interface WorkspaceCoursesResult {
  readonly courses: CourseSummary[]
  readonly missing: boolean
}

/** One global session-search row with enough location context to open it. */
export interface SessionSearchResultView extends SessionSummaryView {
  readonly workspacePath: string
  readonly workspaceTitle: string
  readonly courseId: string
  readonly courseTitle: string
  readonly snippet?: string
}

/** Business-error codes the client can branch on (subset of Python codes). */
export type RpcErrorCode =
  | 'workspace-invalid-path'
  | 'workspace-name-conflict'
  | 'workspace-not-found'
  | 'method-not-found'
  | 'invalid-request'
  | 'model-not-routable'
  | 'agent-not-found'
  | 'agent-not-waiting'
  | 'approval-not-found'
  | 'provider-exists'

export interface RpcError {
  readonly code: RpcErrorCode
  readonly message: string
  readonly details?: Record<string, unknown>
}

export type RpcResponse<R> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly error: RpcError }

/** One directory listing page for the browse picker. */
export interface DirectoryBrowseResult {
  /** Canonical listed directory; `''` marks the roots page (drives / `/`). */
  readonly path: string
  /** Parent directory; `null` means the roots page is one level up. */
  readonly parent: string | null
  readonly entries: ReadonlyArray<{ readonly name: string; readonly path: string }>
}

/** The domain seam handlers run against. */
export interface HostServices {
  readonly registry: {
    create(path: string, title?: string): Promise<{ workspace: Workspace; created: boolean }>
    list(): Workspace[]
    get(id: WorkspaceId): Workspace | undefined
    rename(id: WorkspaceId, title: string): Promise<void>
    delete(id: WorkspaceId): Promise<boolean>
    insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>
    setLastOpenedPath(path: string): Promise<void>
    getLastOpenedPath(): string
  }
  readonly courseSummary: (root: string) => Promise<{ courses: CourseSummary[]; missing: boolean }>
  /** Native directory chooser; resolves `null` on user cancel, throws when the
   * platform has no native picker (FL-02: unavailable ≠ cancel). */
  readonly pickDirectory: () => Promise<string | null>
  /**
   * Server-side directory browse (DSH browse-backend pattern): one fast RPC
   * per folder listing, no native dialog and no long-blocking request —
   * safe behind any proxy. `path: null` lists the roots (drives on Windows).
   */
  readonly browseDirectory: (path: string | null) => Promise<DirectoryBrowseResult>
  /** Session store operations over one course of the active workspace. */
  readonly sessionService: {
    list(courseId: string): Promise<SessionSummaryView[]>
    search(query: string, limit: number): Promise<{ items: SessionSearchResultView[]; hasMore: boolean }>
    create(courseId: string, mode: string, title: string | null): Promise<{ sessionId: string; file: string }>
    rename(courseId: string, sessionId: string, title: string): Promise<{ sessionId: string; title: string }>
    fork(courseId: string, sessionId: string, chatIndex?: number): Promise<{ sessionId: string; file: string }>
    archive(courseId: string, sessionId: string): Promise<{ sessionId: string; archived: true }>
    reorder(courseId: string, sessionId: string, beforeId?: string): Promise<{ sessions: SessionSummaryView[] }>
    restore(courseId: string, sessionId: string): Promise<RestoredSessionView>
    models(courseId: string, sessionId: string): Promise<SessionModelDirectory>
    selectModel(courseId: string, sessionId: string, selection: SessionModelSelection): Promise<SessionModelSelection>
    events(courseId: string, sessionId: string, afterSeq?: number): Promise<{ events: SessionEventView[]; lastSeq: number }>
  }
  readonly agentService: {
    create(courseId: string, mode: string, title: string | null): Promise<{ agentId: string; sessionId: string; status: Record<string, unknown> }>
    resume(courseId: string, sessionId: string): Promise<{ agentId: string; sessionId: string; status: Record<string, unknown> }>
    selectModel(courseId: string, sessionId: string, selection: SessionModelSelection): Promise<SessionModelSelection>
    send(courseId: string, sessionId: string, mode: string, content: string, metadata?: Record<string, unknown>): Promise<Record<string, unknown>>
    list(): Promise<Array<Record<string, unknown>>>
    answer(agentId: string, answer: string): Promise<Record<string, unknown>>
    status(agentId: string): Promise<Record<string, unknown>>
    cancel(agentId: string, keepInbox?: boolean): Promise<Record<string, unknown>>
    whenIdle(agentId: string): Promise<Record<string, unknown>>
    maintenance(agentId: string, kind?: 'checkpoint' | 'compaction', summary?: string | null): Promise<Record<string, unknown>>
    maintenanceJobs(agentId: string): Promise<Array<Record<string, unknown>>>
    dispose(agentId: string): Promise<Record<string, unknown>>
    approvals(agentId?: string): Promise<Array<Record<string, unknown>>>
    resolveApproval(requestId: string, decision: 'allow' | 'deny' | 'cancel'): Promise<Record<string, unknown>>
    projection(agentId: string): Promise<{ plan: Record<string, unknown>; todos: Array<Record<string, unknown>> } & Record<string, unknown>>
    updatePlan(agentId: string, steps: Array<Record<string, unknown>>): Promise<{ steps: Array<Record<string, unknown>>; updatedAt: string | null }>
    updateTodos(agentId: string, items: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>
  }
  /** Resolved chat config for the active workspace (null = unconfigured). */
  readonly chatConfig: () => Promise<{ defaultMode: string; model: string; providerId: string; apiKeyConfigured: boolean } | null>
  /** Settings domain (config.yaml + credentials) over the active workspace. */
  readonly settingsService: {
    get(): Promise<Record<string, unknown>>
    update(partial: Record<string, unknown>): Promise<Record<string, unknown>>
    catalog(): Promise<Array<Record<string, unknown>>>
    discover(input: { baseUrl: string; apiKey?: string | null; apiKeyEnv?: string | null }): Promise<Array<Record<string, unknown>>>
    save(input: Record<string, unknown>): Promise<Record<string, unknown>>
    remove(providerId: string): Promise<Record<string, unknown>>
    activate(providerId: string): Promise<Record<string, unknown>>
    credential(providerId: string, apiKey: string): Promise<Record<string, unknown>>
  }
  /** Course build/learning surface over the active workspace. */
  readonly courseService: {
    syllabus(courseId: string): Promise<Record<string, unknown>>
    setGranularity(courseId: string, granularity: 'fine' | 'coarse'): Promise<Record<string, unknown>>
    progress(courseId: string): Promise<Record<string, unknown>>
    mastery(courseId: string): Promise<Record<string, unknown>>
    quiz(courseId: string, mode: 'review' | 'new', count: number, conceptId: string | null, dueOnly?: boolean): Promise<Array<Record<string, unknown>>>
    files(courseId: string): Promise<Record<string, unknown>>
    workspaceFiles(): Promise<Record<string, unknown>>
    sync(courseId: string, sessionId?: string | null): Promise<Record<string, unknown>>
    ensureCourse(courseId: string): Promise<{ ensured: boolean }>
    ingestUrl(courseId: string, url: string, title: string | null): Promise<Record<string, unknown>>
    createCards(courseId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
    dynamicCards(courseId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
    evalSubmit(courseId: string, taskId: string, answer: string, sessionId?: string | null): AsyncGenerator<Record<string, unknown>>
    job(jobId: string): Record<string, unknown> | undefined
    tools(providerStatus?: Record<string, { available: boolean; reason: string | null; installAction: string | null }>): Array<Record<string, unknown>>
    heatmap(weeks: number): Promise<Record<string, unknown>>
    heatmapDay(date: string): Promise<Record<string, unknown>>
    createCourse(courseName: string, importPaths: string[]): Promise<Record<string, unknown>>
  }
  /** Optional deployment capability snapshot used by `tools.list`. */
  readonly toolProviders?: () => Record<string, { available: boolean; reason: string | null; installAction: string | null }>
}

function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function ok<R>(result: R): RpcResponse<R> {
  return { ok: true, result }
}

function err<R = never>(
  code: RpcErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RpcResponse<R> {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } }
}

interface UnaryHandler<P, R> {
  /** Payload validator; `null` marks a payload-less method. */
  readonly payload: z.ZodType<P> | null
  run(payload: P, services: HostServices): Promise<RpcResponse<R>>
}

const handlers = {
  'workspaces.list': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<WorkspacesListResult>> {
      return ok({
        current: services.registry.getLastOpenedPath() === '' ? null : services.registry.getLastOpenedPath(),
        items: services.registry.list().map(workspaceView),
      })
    },
  },
  'workspaces.open': {
    payload: z.object({ path: z.string().min(1) }),
    async run(payload: { path: string }, services: HostServices): Promise<RpcResponse<OpenWorkspaceResult>> {
      const { workspace, created } = await services.registry.create(payload.path)
      await services.registry.setLastOpenedPath(workspace.path)
      // 项目即课程：打开即初始化——尚未生成 syllabus 的项目就地构建骨架
      // （空生成器，无需 LLM；有资料则同时产出大纲）。
      const { courses, missing } = await services.courseSummary(workspace.path).catch(() => ({ courses: [], missing: true }))
      // FL-18：自动建课失败此前被 `.catch(() => null)` 整个吞掉——用户拿到一
      // 个没有任何提示的空项目。降级为 warning 字段透传，由前端展示。
      let courseWarning: string | null = null
      if (!missing && courses.length === 0) {
        courseWarning = await services.courseService.createCourse(workspace.title, [])
          .then(() => null as string | null)
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      }
      return ok({
        workspace: workspaceView(workspace),
        created,
        ...(courseWarning === null ? {} : { courseWarning }),
      })
    },
  },
  'workspaces.rename': {
    payload: z.object({ id: z.string().min(1), title: z.string().trim().min(1) }),
    async run(
      payload: { id: string; title: string },
      services: HostServices,
    ): Promise<RpcResponse<{ workspace: WorkspaceView }>> {
      const id = payload.id as WorkspaceId
      const workspace = services.registry.get(id)
      if (workspace === undefined) {
        return err('workspace-not-found', `workspace '${payload.id}' is not registered`)
      }
      await services.registry.rename(id, payload.title)
      return ok({ workspace: workspaceView(workspace) })
    },
  },
  'workspaces.reorder': {
    payload: z.object({ id: z.string().min(1), beforeId: z.string().min(1).optional() }),
    async run(
      payload: { id: string; beforeId?: string },
      services: HostServices,
    ): Promise<RpcResponse<{ items: WorkspaceView[] }>> {
      const id = payload.id as WorkspaceId
      const beforeId = payload.beforeId === undefined ? undefined : payload.beforeId as WorkspaceId
      await services.registry.insertBefore(id, beforeId)
      return ok({ items: services.registry.list().map(workspaceView) })
    },
  },
  'workspaces.remove': {
    payload: z.object({ id: z.string().min(1) }),
    async run(
      payload: { id: string },
      services: HostServices,
    ): Promise<RpcResponse<{ items: WorkspaceView[] }>> {
      const id = payload.id as WorkspaceId
      // FL-10：移除"当前项目"时旧实现不清 lastOpenedPath——指针悬空指向已
      // 移除项，重启宿主还会把它恢复为"当前"。回落到列表首位，列表空则清空。
      const removed = services.registry.get(id)
      await services.registry.delete(id)
      if (removed !== undefined && services.registry.getLastOpenedPath() === removed.path) {
        const next = services.registry.list()[0]
        await services.registry.setLastOpenedPath(next?.path ?? '')
      }
      return ok({ items: services.registry.list().map(workspaceView) })
    },
  },
  'workspaces.courses': {
    payload: z.object({ path: z.string().min(1) }),
    async run(
      payload: { path: string },
      services: HostServices,
    ): Promise<RpcResponse<WorkspaceCoursesResult>> {
      return ok(await services.courseSummary(payload.path))
    },
  },
  'host.pickDirectory': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<{ path: string | null }>> {
      return ok({ path: await services.pickDirectory() })
    },
  },
  'host.browseDirectory': {
    payload: z.object({ path: z.string().nullable().optional() }),
    async run(payload: { path?: string | null }, services: HostServices): Promise<RpcResponse<DirectoryBrowseResult>> {
      return ok(await services.browseDirectory(payload.path ?? null))
    },
  },
  'sessions.list': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<{ sessions: SessionSummaryView[] }>> {
      return ok({ sessions: await services.sessionService.list(payload.courseId) })
    },
  },
  'sessions.search': {
    payload: z.object({
      query: z.string().min(1).max(500).refine(query => !query.includes('\0')),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async run(
      payload: { query: string; limit?: number },
      services: HostServices,
    ): Promise<RpcResponse<{ items: SessionSearchResultView[]; hasMore: boolean }>> {
      return ok(await services.sessionService.search(payload.query, payload.limit ?? 50))
    },
  },
  'sessions.create': {
    payload: z.object({ courseId: z.string().min(1), mode: z.string().min(1), title: z.string().nullish() }),
    async run(
      payload: { courseId: string; mode: string; title?: string | null },
      services: HostServices,
    ): Promise<RpcResponse<{ sessionId: string; file: string; wakeup: null }>> {
      const { sessionId, file } = await services.sessionService.create(payload.courseId, payload.mode, payload.title ?? null)
      return ok({ sessionId, file, wakeup: null })
    },
  },
  'agents.create': {
    payload: z.object({ courseId: z.string().min(1), mode: z.string().min(1), title: z.string().nullish() }),
    async run(payload: { courseId: string; mode: string; title?: string | null }, services: HostServices): Promise<RpcResponse<{ agentId: string; sessionId: string; status: Record<string, unknown> }>> {
      return ok(await services.agentService.create(payload.courseId, payload.mode, payload.title ?? null))
    },
  },
  'agents.resume': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1) }),
    async run(payload: { courseId: string; sessionId: string }, services: HostServices): Promise<RpcResponse<{ agentId: string; sessionId: string; status: Record<string, unknown> }>> {
      return ok(await services.agentService.resume(payload.courseId, payload.sessionId))
    },
  },
  'agents.answer': {
    payload: z.object({ agentId: z.string().min(1), answer: z.string().min(1).max(20_000) }),
    async run(payload: { agentId: string; answer: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.answer(payload.agentId, payload.answer))
    },
  },
  'agents.send': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), mode: z.string().min(1), content: z.string().min(1).max(20_000), metadata: z.record(z.string(), z.unknown()).optional() }),
    async run(payload: { courseId: string; sessionId: string; mode: string; content: string; metadata?: Record<string, unknown> }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.send(payload.courseId, payload.sessionId, payload.mode, payload.content, payload.metadata))
    },
  },
  'agents.status': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.status(payload.agentId))
    },
  },
  'agents.list': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<{ agents: Array<Record<string, unknown>> }>> {
      return ok({ agents: await services.agentService.list() })
    },
  },
  'agents.cancel': {
    payload: z.object({ agentId: z.string().min(1), keepInbox: z.boolean().optional() }),
    async run(payload: { agentId: string; keepInbox?: boolean }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.cancel(payload.agentId, payload.keepInbox ?? false))
    },
  },
  'agents.whenIdle': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.whenIdle(payload.agentId))
    },
  },
  'agents.maintenance': {
    payload: z.object({ agentId: z.string().min(1), kind: z.enum(['checkpoint', 'compaction']).optional(), summary: z.string().max(8_000).nullish() }),
    async run(payload: { agentId: string; kind?: 'checkpoint' | 'compaction'; summary?: string | null }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.maintenance(payload.agentId, payload.kind ?? 'checkpoint', payload.summary ?? null))
    },
  },
  'agents.maintenanceJobs': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<{ jobs: Array<Record<string, unknown>> }>> {
      return ok({ jobs: await services.agentService.maintenanceJobs(payload.agentId) })
    },
  },
  'agents.dispose': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.dispose(payload.agentId))
    },
  },
  'agents.projection': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.projection(payload.agentId))
    },
  },
  'plans.get': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const projection = await services.agentService.projection(payload.agentId)
      return ok({ ...projection.plan })
    },
  },
  'plans.update': {
    payload: z.object({ agentId: z.string().min(1), steps: z.array(z.record(z.string(), z.unknown())).max(100) }),
    async run(payload: { agentId: string; steps: Array<Record<string, unknown>> }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const plan = await services.agentService.updatePlan(payload.agentId, payload.steps)
      return ok({ steps: plan.steps, updatedAt: plan.updatedAt })
    },
  },
  'todos.get': {
    payload: z.object({ agentId: z.string().min(1) }),
    async run(payload: { agentId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const projection = await services.agentService.projection(payload.agentId)
      return ok({ items: projection.todos })
    },
  },
  'todos.update': {
    payload: z.object({ agentId: z.string().min(1), items: z.array(z.record(z.string(), z.unknown())).max(100) }),
    async run(payload: { agentId: string; items: Array<Record<string, unknown>> }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok({ items: await services.agentService.updateTodos(payload.agentId, payload.items) })
    },
  },
  'approvals.list': {
    payload: z.object({ agentId: z.string().min(1).optional() }),
    async run(payload: { agentId?: string }, services: HostServices): Promise<RpcResponse<{ items: Array<Record<string, unknown>> }>> {
      return ok({ items: await services.agentService.approvals(payload.agentId) })
    },
  },
  'approvals.resolve': {
    payload: z.object({ requestId: z.string().min(1), decision: z.enum(['allow', 'deny', 'cancel']) }),
    async run(payload: { requestId: string; decision: 'allow' | 'deny' | 'cancel' }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.agentService.resolveApproval(payload.requestId, payload.decision))
    },
  },
  'sessions.rename': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), title: z.string().min(1) }),
    async run(
      payload: { courseId: string; sessionId: string; title: string },
      services: HostServices,
    ): Promise<RpcResponse<{ sessionId: string; title: string }>> {
      return ok(await services.sessionService.rename(payload.courseId, payload.sessionId, payload.title))
    },
  },
  'sessions.fork': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), chatIndex: z.number().int().nonnegative().optional() }),
    async run(
      payload: { courseId: string; sessionId: string; chatIndex?: number },
      services: HostServices,
    ): Promise<RpcResponse<{ sessionId: string; file: string }>> {
      return ok(await services.sessionService.fork(payload.courseId, payload.sessionId, payload.chatIndex))
    },
  },
  'sessions.archive': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1) }),
    async run(
      payload: { courseId: string; sessionId: string },
      services: HostServices,
    ): Promise<RpcResponse<{ sessionId: string; archived: true }>> {
      return ok(await services.sessionService.archive(payload.courseId, payload.sessionId))
    },
  },
  'sessions.reorder': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), beforeId: z.string().min(1).optional() }),
    async run(
      payload: { courseId: string; sessionId: string; beforeId?: string },
      services: HostServices,
    ): Promise<RpcResponse<{ sessions: SessionSummaryView[] }>> {
      return ok(await services.sessionService.reorder(payload.courseId, payload.sessionId, payload.beforeId))
    },
  },
  'sessions.restore': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1) }),
    async run(
      payload: { courseId: string; sessionId: string },
      services: HostServices,
    ): Promise<RpcResponse<RestoredSessionView>> {
      return ok(await services.sessionService.restore(payload.courseId, payload.sessionId))
    },
  },
  'sessions.models': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1) }),
    async run(payload: { courseId: string; sessionId: string }, services: HostServices): Promise<RpcResponse<SessionModelDirectory>> {
      return ok(await services.sessionService.models(payload.courseId, payload.sessionId))
    },
  },
  'sessions.selectModel': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), effort: z.string().min(1).nullable().optional() }),
    async run(payload: { courseId: string; sessionId: string; provider: string; model: string; effort?: string | null }, services: HostServices): Promise<RpcResponse<{ selected: SessionModelSelection }>> {
      const selection: SessionModelSelection = { provider: payload.provider, model: payload.model, ...(payload.effort === undefined ? {} : { effort: payload.effort }) }
      const selected = await services.sessionService.selectModel(payload.courseId, payload.sessionId, selection)
      await services.agentService.selectModel(payload.courseId, payload.sessionId, selected)
      return ok({ selected })
    },
  },
  'sessions.events': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().min(1), afterSeq: z.number().int().min(0).optional() }),
    async run(payload: { courseId: string; sessionId: string; afterSeq?: number }, services: HostServices): Promise<RpcResponse<{ events: SessionEventView[]; lastSeq: number }>> {
      return ok(await services.sessionService.events(payload.courseId, payload.sessionId, payload.afterSeq ?? 0))
    },
  },
  'settings.get': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.get())
    },
  },
  'settings.update': {
    payload: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      apiBase: z.string().nullish(),
      temperature: z.number().optional(),
      maxConcurrency: z.number().optional(),
      defaultMode: z.string().optional(),
      agentPreset: z.string().optional(),
      permissionPreset: z.string().optional(),
      plugins: z.record(z.string(), z.boolean()).optional(),
    }),
    async run(payload: Record<string, unknown>, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.update(payload))
    },
  },
  'settings.providerCatalog': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<{ catalog: Array<Record<string, unknown>> }>> {
      return ok({ catalog: await services.settingsService.catalog() })
    },
  },
  'settings.discoverModels': {
    payload: z.object({ baseUrl: z.string().min(1), apiKey: z.string().nullish(), apiKeyEnv: z.string().nullish() }),
    async run(
      payload: { baseUrl: string; apiKey?: string | null; apiKeyEnv?: string | null },
      services: HostServices,
    ): Promise<RpcResponse<{ models: Array<Record<string, unknown>> }>> {
      return ok({ models: await services.settingsService.discover(payload) })
    },
  },
  'settings.saveProvider': {
    payload: z.object({
      id: z.string().min(1),
      // 显示名称可选：域层留空回退为 id（UI placeholder「可选」契约）。
      name: z.string(),
      model: z.string(),
      baseUrl: z.string().nullish(),
      temperature: z.number().optional(),
      maxConcurrency: z.number().optional(),
      // null = 保留现有列表；[] = 显式清空；数组 = 整体替换（merge 语义）。
      models: z.array(z.object({ id: z.string(), name: z.string(), contextWindow: z.number().nullish(), maxTokens: z.number().nullish() })).nullable().optional(),
      overwrite: z.boolean().optional(),
    }),
    async run(payload: Record<string, unknown>, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.save(payload))
    },
  },
  'settings.deleteProvider': {
    payload: z.object({ providerId: z.string().min(1) }),
    async run(payload: { providerId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.remove(payload.providerId))
    },
  },
  'settings.activateProvider': {
    payload: z.object({ providerId: z.string().min(1) }),
    async run(payload: { providerId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.activate(payload.providerId))
    },
  },
  'settings.setCredential': {
    payload: z.object({ providerId: z.string().min(1), apiKey: z.string() }),
    async run(payload: { providerId: string; apiKey: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.settingsService.credential(payload.providerId, payload.apiKey))
    },
  },
  'courses.syllabus': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.syllabus(payload.courseId))
    },
  },
  'courses.syllabusGranularity': {
    payload: z.object({ courseId: z.string().min(1), granularity: z.enum(['fine', 'coarse']) }),
    async run(payload: { courseId: string; granularity: 'fine' | 'coarse' }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.setGranularity(payload.courseId, payload.granularity))
    },
  },
  'courses.progress': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.progress(payload.courseId))
    },
  },
  'courses.mastery': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.mastery(payload.courseId))
    },
  },
  'courses.quiz': {
    payload: z.object({ courseId: z.string().min(1), mode: z.enum(['review', 'new']), count: z.number().int().min(1).max(20).default(5), conceptId: z.string().nullish(), dueOnly: z.boolean().optional() }),
    async run(payload: { courseId: string; mode: 'review' | 'new'; count: number; conceptId?: string | null; dueOnly?: boolean }, services: HostServices): Promise<RpcResponse<{ tasks: Array<Record<string, unknown>> }>> {
      return ok({ tasks: await services.courseService.quiz(payload.courseId, payload.mode, payload.count, payload.conceptId ?? null, payload.dueOnly ?? false) })
    },
  },
  'courses.files': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.files(payload.courseId))
    },
  },
  'workspace.files': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.workspaceFiles())
    },
  },
  'courses.sync': {
    payload: z.object({ courseId: z.string().min(1), sessionId: z.string().nullish() }),
    async run(payload: { courseId: string; sessionId?: string | null }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.sync(payload.courseId, payload.sessionId ?? null))
    },
  },
  'courses.ensure': {
    payload: z.object({ courseId: z.string().min(1) }),
    async run(payload: { courseId: string }, services: HostServices): Promise<RpcResponse<{ ensured: boolean }>> {
      return ok(await services.courseService.ensureCourse(payload.courseId))
    },
  },
  'courses.ingestUrl': {
    payload: z.object({ courseId: z.string().min(1), url: z.string().min(1), title: z.string().nullish() }),
    async run(payload: { courseId: string; url: string; title?: string | null }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.ingestUrl(payload.courseId, payload.url, payload.title ?? null))
    },
  },
  'courses.cards': {
    payload: z.object({ courseId: z.string().min(1), content: z.string().min(1), title: z.string().nullish(), conceptId: z.string().nullish(), count: z.number().int().min(1).max(5).nullish(), sessionId: z.string().nullish() }),
    async run(payload: Record<string, unknown>, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const courseId = String(payload['courseId'])
      const inner = { content: String(payload['content']), title: payload['title'] as string | null, conceptId: payload['conceptId'] as string | null, count: payload['count'] as number | undefined, sessionId: payload['sessionId'] as string | null }
      return ok(await services.courseService.createCards(courseId, inner))
    },
  },
  'courses.dynamicCards': {
    payload: z.object({ courseId: z.string().min(1), taskId: z.string().min(1), misconception: z.string().min(1), content: z.string().nullish(), targetId: z.string().nullish(), count: z.number().int().min(1).max(5).nullish(), sessionId: z.string().nullish() }),
    async run(payload: Record<string, unknown>, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const courseId = String(payload['courseId'])
      const inner = { taskId: String(payload['taskId']), misconception: String(payload['misconception']), content: payload['content'] as string | null, targetId: payload['targetId'] as string | null, count: payload['count'] as number | undefined, sessionId: payload['sessionId'] as string | null }
      return ok(await services.courseService.dynamicCards(courseId, inner))
    },
  },
  'jobs.get': {
    payload: z.object({ jobId: z.string().min(1) }),
    async run(payload: { jobId: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      const job = services.courseService.job(payload.jobId)
      if (job === undefined) return err('invalid-request', `任务不存在: ${payload.jobId}`)
      return ok(job)
    },
  },
  'tools.list': {
    payload: null,
    async run(_payload: void, services: HostServices): Promise<RpcResponse<{ tools: Array<Record<string, unknown>> }>> {
      return ok({ tools: services.courseService.tools(services.toolProviders?.()) })
    },
  },
  'metrics.heatmap': {
    payload: z.object({ weeks: z.number().int().min(1).max(52).default(12) }),
    async run(payload: { weeks: number }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.heatmap(payload.weeks))
    },
  },
  'workspaces.createCourse': {
    payload: z.object({ courseName: z.string().min(1), importPaths: z.array(z.string()).default([]) }),
    async run(payload: { courseName: string; importPaths: string[] }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.createCourse(payload.courseName, payload.importPaths))
    },
  },
  'metrics.heatmapDay': {
    payload: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    async run(payload: { date: string }, services: HostServices): Promise<RpcResponse<Record<string, unknown>>> {
      return ok(await services.courseService.heatmapDay(payload.date))
    },
  },
} satisfies Record<string, UnaryHandler<unknown, unknown>>

export type RpcMethod = keyof typeof handlers

/**
 * Dispatch one unary method call. Business errors are returned in the
 * envelope (never thrown); unknown methods and malformed payloads resolve
 * as `method-not-found` / `invalid-request`.
 * @param method - Dot-path method name, e.g. `workspaces.open`.
 * @param payload - Method payload, `undefined` for payload-less methods.
 * @param services - The domain seam.
 * @returns the typed envelope.
 */
export async function dispatch(
  method: string,
  payload: unknown,
  services: HostServices,
): Promise<RpcResponse<unknown>> {
  const handler = (handlers as Record<string, UnaryHandler<unknown, unknown>>)[method]
  if (handler === undefined) return err('method-not-found', `unknown method '${method}'`)
  let parsed: unknown
  if (handler.payload === null) {
    parsed = undefined
  } else {
    const validation = handler.payload.safeParse(payload)
    if (!validation.success) {
      return err('invalid-request', `invalid payload for '${method}': ${validation.error.issues[0]?.message ?? 'unknown'}`)
    }
    parsed = validation.data
  }
  try {
    return await handler.run(parsed, services)
  } catch (error) {
    if (error instanceof WorkspaceNameConflictError) {
      return err('workspace-name-conflict', error.message, { name: error.workspaceName })
    }
    if (error instanceof WorkspaceOrderInvalidError) {
      return err('workspace-not-found', error.message, { workspaceId: error.workspaceId })
    }
    if (error instanceof ProviderExistsError) {
      return err('provider-exists', error.message, { providerId: error.providerId })
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT') || message.includes('not a directory')) {
      return err('workspace-invalid-path', `cannot open workspace: ${message}`)
    }
    if (message.startsWith('模型不可用:') || message.startsWith('Provider 未配置凭据:')) {
      return err('model-not-routable', message)
    }
    if (message.startsWith('Agent 不存在:')) {
      return err('agent-not-found', message)
    }
    if (message.includes('没有待回答的问题')) {
      return err('agent-not-waiting', message)
    }
    if (message.startsWith('审批请求不存在:')) {
      return err('approval-not-found', message)
    }
    return err('invalid-request', message)
  }
}
