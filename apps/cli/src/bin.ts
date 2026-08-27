/**
 * StudyClaw CLI entry (M1): `studyclaw serve` runs the host — cordis
 * assembly (storage + workspace registry) and a node:http server that
 * dispatches the RPC method table over `POST /api/<method>`.
 *
 * Dev mode runs this through tsx; the packaged npm bin (M5) runs the tsdown
 * build of this same entry.
 */

import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@studyclaw/workspace'
import { AcpProtocolError, AcpRouter, parseAcpRequest, type AcpHost, type AcpNotification, type AcpRequest, type AcpUpdate } from '@studyclaw/acp'
import { listCourseSummaries } from '@studyclaw/course-summary'
import { migrateLegacyLayout } from '@studyclaw/course-builder'
import { dispatch, type HostServices, type SessionSearchResultView } from '@studyclaw/apiproxy'
import { pickNativeDirectory } from '@studyclaw/directory-picker-native'
import {
  activateProvider,
  archiveSession,
  chatStream,
  createSession,
  deleteProvider,
  discoverModels,
  forkSession,
  listSessions,
  loadChatConfig,
  providerCatalog,
  renameSession,
  reorderSession,
  restoreSession,
  sessionEvents,
  sessionModels,
  selectSessionModel,
  searchSessions,
  saveProvider,
  setCredential,
  settingsPayload,
  updateSettings,
  LearningAgentService,
} from '@studyclaw/chat-service'
import { migrateLegacySession } from '@studyclaw/session'
import type { LearningMode } from '@studyclaw/session'
import { createCourseService } from '@studyclaw/chat-service'
import { AgentRegistry } from '@studyclaw/agent'
import { hostRpc } from './lib/client.ts'
import { UsageError } from './lib/args.ts'
import { quizCommand } from './commands/quiz.ts'
import { reviewCommand } from './commands/review.ts'
import { chatCommand } from './commands/chat.ts'

function hostHome(): string {
  return process.env.STUDYCLAW_HOME ?? join(homedir(), '.studyclaw')
}

interface StartupRegistry {
  readonly lastOpenedPath: string
  setLastOpenedPath(path: string): Promise<unknown>
  resolveByPath(path: string): Promise<unknown>
  create(path: string, title?: string): Promise<unknown>
}

interface DirectoryEntry {
  readonly name: string
  readonly path: string
}

interface DirectoryBrowseResult {
  readonly path: string
  readonly parent: string | null
  readonly entries: DirectoryEntry[]
}

/** Windows system folders that must never surface in the browse picker. */
const BROWSE_HIDDEN = new Set(['$RECYCLE.BIN', 'System Volume Information', 'Config.Msi', 'Recovery'])

/**
 * DSH browse-backend pattern: server-side directory listing, one fast RPC per
 * page. `null` lists the roots (drive letters on Windows, `/` elsewhere).
 * Unlike the native modal dialog this never blocks a request, so it is safe
 * behind the dev proxy and needs no interactive desktop.
 */
async function browseLocalDirectory(requested: string | null | undefined): Promise<DirectoryBrowseResult> {
  const { readdir } = await import('node:fs/promises')
  if (requested === null || requested === undefined || requested.trim() === '') {
    if (process.platform !== 'win32') {
      const entries = (await readdir('/', { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({ name: entry.name, path: join('/', entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { path: '', parent: null, entries }
    }
    const entries: DirectoryEntry[] = []
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`
      try {
        if ((await stat(drive)).isDirectory()) entries.push({ name: drive, path: drive })
      } catch {
        // 不存在的盘符跳过。
      }
    }
    return { path: '', parent: null, entries }
  }
  const canonical = await realpath(requested.trim())
  if (!(await stat(canonical)).isDirectory()) throw new Error(`不是目录: ${canonical}`)
  const children = await readdir(canonical, { withFileTypes: true }).catch(() => [])
  const entries = children
    .filter(entry => entry.isDirectory() && !BROWSE_HIDDEN.has(entry.name))
    .map(entry => ({ name: entry.name, path: join(canonical, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const isDriveRoot = /^[A-Za-z]:\\?$/.test(canonical) || canonical === '/'
  return { path: canonical, parent: isDriveRoot ? null : dirname(canonical), entries }
}

/**
 * DSH-style startup hygiene:
 * 1. Drop a dangling or temp-hosted "current workspace" pointer (e2e harness
 *    workspaces living under os.tmpdir() are the common culprit) so a fresh
 *    run boots into the empty first-run state instead of a mock project.
 * 2. Import legacy `workspaces.json` records (Python-era registry) once, so
 *    previously opened projects keep appearing in the sidebar without
 *    re-adoption. Only directories that still exist are imported.
 */
async function healStartupRegistry(registry: StartupRegistry): Promise<void> {
  const last = registry.lastOpenedPath
  if (last !== '') {
    let drop = false
    try {
      const info = await stat(last)
      const canonical = await realpath(last)
      const tmpRoot = await realpath(tmpdir())
      drop = !info.isDirectory() || canonical.toLowerCase().startsWith(tmpRoot.toLowerCase() + '\\')
        || canonical.toLowerCase().startsWith(tmpRoot.toLowerCase() + '/')
    } catch {
      drop = true
    }
    if (drop) {
      console.warn(`[studyclaw] 启动自愈：lastOpenedPath 指向临时/失效目录（${last}），已清空`)
      await registry.setLastOpenedPath('')
    }
  }

  const legacyPath = join(hostHome(), 'workspaces.json')
  const raw = await readFile(legacyPath, 'utf8').catch(() => null)
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw) as { items?: Array<{ path?: unknown; name?: unknown }> }
    const items = Array.isArray(parsed.items) ? parsed.items : []
    for (const item of items) {
      const path = typeof item.path === 'string' ? item.path : ''
      const name = typeof item.name === 'string' ? item.name : undefined
      if (path === '') continue
      try {
        if (await registry.resolveByPath(path) !== undefined) continue
        await registry.create(path, name)
        console.log(`[studyclaw] 迁移历史项目记录: ${path}`)
      } catch {
        // 目录已不存在的记录跳过（realpath 抛错）。
      }
    }
  } catch {
    // 损坏的 legacy 文件忽略。
  }
  // 一次性导入：完成后改名封存。否则每次重启都会把用户已移除的项目复活。
  const { rename } = await import('node:fs/promises')
  await rename(legacyPath, `${legacyPath}.migrated`).catch(() => undefined)
}

function usage(): void {
  console.log('usage: studyclaw serve [--port <n>] | status | session migrate [<sessionId>] | quiz [count] [--mode new|review] [--course <id>] [--concept <id>] | review [count] [--course <id>] [--concept <id>] | chat [message] [--mode socratic|quick|feynman|debug] [--course <id>] [--session <id>] [--new] [--concept <id>] [--turns N] | agent <create|resume|prompt|send|answer|status|cancel|whenIdle|maintenance|maintenance-jobs|dispose> | approvals <list|resolve> | plan <get|update> | todo <get|update> | acp')
}

function hostUrl(): string {
  return (process.env.STUDYCLAW_HOST_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8080'}`).replace(/\/$/, '')
}

async function acpRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${hostUrl()}/api/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `cli-${Date.now()}`, method, params }),
  })
  const message = await response.json() as { result?: T; error?: { code?: number; message?: string } }
  if (!response.ok || message.error !== undefined) throw new Error(`${message.error?.code ?? `HTTP_${response.status}`}: ${message.error?.message ?? response.statusText}`)
  return message.result as T
}

async function agentCommand(argv: string[]): Promise<void> {
  const action = argv[1]
  let result: unknown
  if (action === 'create') result = await hostRpc('agents.create', { courseId: argv[2], mode: argv[3] ?? 'socratic', title: argv[4] ?? null })
  else if (action === 'resume') result = await hostRpc('agents.resume', { courseId: argv[2], sessionId: argv[3] })
  else if (action === 'answer') result = await hostRpc('agents.answer', { agentId: argv[2], answer: argv.slice(3).join(' ') })
  else if (action === 'prompt' || action === 'send') {
    const courseId = argv[2]
    const sessionId = action === 'send' ? argv[3] : undefined
    const message = argv.slice(action === 'send' ? 4 : 3).join(' ').trim()
    if (courseId === undefined || message === '') throw new Error(`用法：studyclaw agent ${action} <courseId>${action === 'send' ? ' <sessionId>' : ''} <message>`)
    result = await acpRpc('session.prompt', {
      courseId,
      message,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }
  else if (action === 'maintenance-jobs') result = await hostRpc('agents.maintenanceJobs', { agentId: argv[2] })
  else if (action === 'status' || action === 'cancel' || action === 'whenIdle' || action === 'maintenance' || action === 'dispose') {
    const method = `agents.${action}`
    result = await hostRpc(method, { agentId: argv[2], ...(action === 'cancel' ? { keepInbox: argv[3] === 'true' } : {}), ...(action === 'maintenance' ? { kind: argv[3] ?? 'checkpoint' } : {}) })
  } else throw new Error('用法：studyclaw agent create <courseId> [mode] [title] | resume <courseId> <sessionId> | prompt <courseId> <message> | send <courseId> <sessionId> <message> | answer <agentId> <text> | status|cancel|whenIdle|maintenance|maintenance-jobs|dispose <agentId>')
  console.log(JSON.stringify(result, null, 2))
}

async function approvalsCommand(argv: string[]): Promise<void> {
  const action = argv[1]
  if (action === 'list') console.log(JSON.stringify(await hostRpc('approvals.list', argv[2] ? { agentId: argv[2] } : {}), null, 2))
  else if (action === 'resolve') console.log(JSON.stringify(await hostRpc('approvals.resolve', { requestId: argv[2], decision: argv[3] ?? 'deny' }), null, 2))
  else throw new Error('用法：studyclaw approvals list [agentId] | resolve <requestId> <allow|deny|cancel>')
}

async function planTodoCommand(kind: 'plan' | 'todo', argv: string[]): Promise<void> {
  const action = argv[1]
  const agentId = argv[2]
  if (action === 'get') console.log(JSON.stringify(await hostRpc(`${kind}s.get`, { agentId }), null, 2))
  else if (action === 'update') {
    const value = JSON.parse(argv.slice(3).join(' ')) as unknown
    const key = kind === 'plan' ? 'steps' : 'items'
    if (!Array.isArray(value)) throw new Error(`${key} 必须是 JSON 数组`)
    console.log(JSON.stringify(await hostRpc(`${kind}s.update`, { agentId, [key]: value }), null, 2))
  } else throw new Error(`用法：studyclaw ${kind} get|update <agentId> [JSON array]`)
}

async function acpStdio(): Promise<void> {
  const { createInterface } = await import('node:readline')
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    if (line.trim() === '') continue
    try {
      const request = parseAcpRequest(JSON.parse(line) as unknown)
      const wantsStream = request.method === 'session.prompt' || request.method === 'session.send' || request.method === 'prompt'
      const outgoing = wantsStream && typeof request.params === 'object' && request.params !== null
        ? { ...request, params: { ...(request.params as Record<string, unknown>), stream: true } }
        : request
      const response = await fetch(`${hostUrl()}/api/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(wantsStream ? { accept: 'application/x-ndjson' } : {}) },
        body: JSON.stringify(outgoing),
      })
      process.stdout.write(`${await response.text()}\n`)
    } catch (error) {
      const code = error instanceof AcpProtocolError ? error.code : -32603
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`)
    }
  }
}

async function serve(port: number): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: hostHome() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)

  const registry = ctx.workspaceRegistry
  await healStartupRegistry(registry)
  if (registry.lastOpenedPath !== '') await migrateLegacyLayout(registry.lastOpenedPath).catch(() => undefined)
  const agentRegistry = new AgentRegistry()
  const agentService = new LearningAgentService(agentRegistry)
  // Rehydrate only durable inbox/interaction work. Idle sessions stay cold
  // until the client explicitly resumes them, matching DSH host startup.
  if (registry.lastOpenedPath !== '') await agentService.recover(registry.lastOpenedPath)
  const acpRequests = new Map<string, AbortController>()

  const configFacts = async (): Promise<import('@studyclaw/chat-service').ResolvedChatConfig | null> =>
    registry.lastOpenedPath === '' ? null : await loadChatConfig(registry.lastOpenedPath).catch(() => null)

  function wrapCourseService(): HostServices['courseService'] {
    const activeRoot = (): string => registry.lastOpenedPath
    const courseService = createCourseService(configFacts)
    return {
      syllabus: async courseId => courseService.syllabus(activeRoot(), courseId),
      setGranularity: async (courseId, granularity) => courseService.setGranularity(activeRoot(), courseId, granularity),
      progress: async courseId => courseService.progress(activeRoot(), courseId),
      mastery: async courseId => courseService.mastery(activeRoot(), courseId),
      quiz: async (courseId, mode, count, conceptId, dueOnly) => courseService.quiz(activeRoot(), courseId, mode, count, conceptId, dueOnly),
      files: async courseId => courseService.files(activeRoot(), courseId),
      workspaceFiles: async () => courseService.workspaceFiles(activeRoot()),
      sync: async (courseId, sessionId) => courseService.sync(activeRoot(), courseId, sessionId),
      ensureCourse: courseId => courseService.ensureCourse(activeRoot(), courseId),
      ingestUrl: async (courseId, url, title) => courseService.ingestUrl(activeRoot(), courseId, url, title),
      createCards: async (courseId, payload) => courseService.createCards(activeRoot(), courseId, payload as { content: string; title?: string | null; conceptId?: string | null; count?: number; sessionId?: string | null }),
      dynamicCards: async (courseId, payload) => courseService.dynamicCards(activeRoot(), courseId, payload as { taskId: string; misconception: string; content?: string | null; targetId?: string | null; count?: number; sessionId?: string | null }),
      evalSubmit: (courseId, taskId, answer, sessionId) => courseService.evalSubmit(activeRoot(), courseId, taskId, answer, sessionId),
      job: jobId => courseService.job(jobId) as Record<string, unknown> | undefined,
      tools: providerStatus => courseService.tools(providerStatus),
      heatmap: async weeks => courseService.heatmap(activeRoot(), weeks),
      heatmapDay: async date => courseService.heatmapDay(activeRoot(), date),
      createCourse: async (courseName, importPaths) => courseService.createCourse(activeRoot(), courseName, importPaths),
    }
  }

  const services: HostServices = {
    registry: {
      create: (path, title) => registry.create(path, title),
      list: () => registry.list(),
      get: id => registry.get(id),
      rename: (id, title) => registry.rename(id, title),
      delete: id => registry.delete(id),
      insertBefore: (id, beforeId) => registry.insertBefore(id, beforeId),
      setLastOpenedPath: async path => {
        await registry.setLastOpenedPath(path)
        await agentService.recover(path)
      },
      getLastOpenedPath: () => registry.lastOpenedPath,
    },
    courseSummary: async root => {
      // v2 布局收拢：旧根目录产物一次性搬进 .studyclaw/（marker 守卫，幂等）。
      await migrateLegacyLayout(root).catch(() => undefined)
      return listCourseSummaries(root)
    },
    // Native OS folder picker. On Windows this spawns a child process that
    // opens the modern IFileOpenDialog via koffi (the dialog is the child's
    // first window, so Windows foregrounds it — the PowerShell
    // FolderBrowserDialog spawned from this background host never surfaced;
    // see @studyclaw/directory-picker-native). Non-Windows resolves null and
    // the client falls back to the browse backend.
    pickDirectory: () => pickNativeDirectory(),
    browseDirectory: path => browseLocalDirectory(path),
    sessionService: {
      list: courseId => listSessions(registry.lastOpenedPath, courseId),
      search: async (query, limit) => {
        const normalized = query.trim().toLowerCase()
        const matches: Array<SessionSearchResultView & { rank: number }> = []
        for (const workspace of registry.list()) {
          const { courses, missing } = await listCourseSummaries(workspace.path).catch(() => ({ courses: [], missing: true }))
          if (missing) continue
          for (const course of courses) {
            const found = await searchSessions(workspace.path, course.id, query).catch(() => [])
            const included = new Set(found.map(session => session.sessionId))
            const contextMatch = workspace.title.toLowerCase().includes(normalized)
              || course.title.toLowerCase().includes(normalized)
            for (const session of found) {
              matches.push({
                sessionId: session.sessionId,
                title: session.title,
                mode: session.mode,
                turns: session.turns,
                createdAt: session.createdAt,
                lastActiveAt: session.lastActiveAt,
                workspacePath: workspace.path,
                workspaceTitle: workspace.title,
                courseId: course.id,
                courseTitle: course.title,
                ...(session.snippet === undefined ? {} : { snippet: session.snippet }),
                rank: session.match === 'title' ? 0 : 1,
              })
            }
            if (!contextMatch) continue
            for (const session of await listSessions(workspace.path, course.id).catch(() => [])) {
              if (included.has(session.sessionId)) continue
              matches.push({
                ...session,
                workspacePath: workspace.path,
                workspaceTitle: workspace.title,
                courseId: course.id,
                courseTitle: course.title,
                rank: 1,
              })
            }
          }
        }
        matches.sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank
          const byActivity = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)
          return byActivity !== 0 ? byActivity : b.sessionId.localeCompare(a.sessionId)
        })
        return {
          items: matches.slice(0, limit).map(({ rank: _rank, ...item }) => item),
          hasMore: matches.length > limit,
        }
      },
      create: (courseId, mode, title) => createSession(registry.lastOpenedPath, courseId, mode as LearningMode, title),
      rename: (courseId, sessionId, title) => renameSession(registry.lastOpenedPath, courseId, sessionId, title),
      fork: (courseId, sessionId, chatIndex) => forkSession(registry.lastOpenedPath, courseId, sessionId, chatIndex),
      archive: (courseId, sessionId) => archiveSession(registry.lastOpenedPath, courseId, sessionId),
      reorder: (courseId, sessionId, beforeId) => reorderSession(registry.lastOpenedPath, courseId, sessionId, beforeId),
      restore: (courseId, sessionId) => restoreSession(registry.lastOpenedPath, courseId, sessionId),
      models: (courseId, sessionId) => sessionModels(registry.lastOpenedPath, courseId, sessionId),
      selectModel: (courseId, sessionId, selection) => selectSessionModel(registry.lastOpenedPath, courseId, sessionId, selection),
      events: (courseId, sessionId, afterSeq) => sessionEvents(registry.lastOpenedPath, courseId, sessionId, afterSeq),
    },
    agentService: {
      create: (courseId, mode, title) => agentService.create(registry.lastOpenedPath, courseId, mode, title),
      resume: (courseId, sessionId) => agentService.resume(registry.lastOpenedPath, courseId, sessionId),
      selectModel: (_courseId, sessionId, selection) => agentService.selectModel(sessionId, selection),
      send: (courseId, sessionId, mode, content, metadata) => agentService.send(registry.lastOpenedPath, courseId, sessionId, mode as import('@studyclaw/session').LearningMode, content, metadata),
      list: async () => agentService.list(),
      answer: (agentId, answer) => agentService.answer(agentId, answer),
      status: async agentId => agentService.status(agentId),
      cancel: (agentId, keepInbox) => agentService.cancel(agentId, keepInbox),
      whenIdle: agentId => agentService.whenIdle(agentId),
      maintenance: async (agentId, kind, summary) => await agentService.maintenance(agentId, kind, summary) as unknown as Record<string, unknown>,
      maintenanceJobs: async agentId => agentService.maintenanceJobs(agentId) as unknown as Record<string, unknown>[],
      dispose: agentId => agentService.dispose(agentId),
      approvals: async agentId => agentService.listApprovals(agentId) as unknown as Record<string, unknown>[],
      resolveApproval: async (requestId, decision) => agentService.resolveApproval(requestId, decision) as unknown as Record<string, unknown>,
      projection: async agentId => await agentService.projection(agentId) as unknown as { plan: Record<string, unknown>; todos: Array<Record<string, unknown>> } & Record<string, unknown>,
      updatePlan: async (agentId, steps) => {
        const plan = await agentService.updatePlan(agentId, steps)
        return { steps: plan.steps as unknown as Array<Record<string, unknown>>, updatedAt: plan.updatedAt }
      },
      updateTodos: async (agentId, items) => await agentService.updateTodos(agentId, items) as unknown as Array<Record<string, unknown>>,
    },
    chatConfig: async () => {
      const config = await loadChatConfig(registry.lastOpenedPath)
      return {
        defaultMode: config.defaultMode,
        model: config.model,
        providerId: config.providerId,
        apiKeyConfigured: config.apiKey !== null,
      }
    },
    settingsService: {
      get: async () => settingsPayload(registry.lastOpenedPath) as unknown as Record<string, unknown>,
      update: async partial => updateSettings(registry.lastOpenedPath, partial) as unknown as Record<string, unknown>,
      catalog: async () => providerCatalog() as unknown as Array<Record<string, unknown>>,
      discover: async input => discoverModels(input) as unknown as Array<Record<string, unknown>>,
      save: async input => saveProvider(registry.lastOpenedPath, input as Parameters<typeof saveProvider>[1]) as unknown as Record<string, unknown>,
      remove: async providerId => deleteProvider(registry.lastOpenedPath, providerId) as unknown as Record<string, unknown>,
      activate: async providerId => activateProvider(registry.lastOpenedPath, providerId) as unknown as Record<string, unknown>,
      credential: async (providerId, apiKey) => setCredential(registry.lastOpenedPath, providerId, apiKey) as unknown as Record<string, unknown>,
    },
    courseService: wrapCourseService(),
    toolProviders: () => ({
      subprocess: { available: false, reason: '默认拒绝无隔离的本机命令执行', installAction: '配置 sandbox Provider' },
      network: { available: true, reason: null, installAction: null },
      sandbox: { available: false, reason: '未安装隔离执行 Provider', installAction: '安装/配置 E2B 或本机 sandbox' },
      subagent: { available: true, reason: null, installAction: null },
      lsp: { available: false, reason: '当前工作区未启用语言服务器', installAction: '配置 LSP Provider' },
    }),
  }

  async function acpCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const envelope = await dispatch(method, params, services)
    if (!envelope.ok) {
      throw new AcpProtocolError(-32000, envelope.error.message, {
        code: envelope.error.code,
        details: envelope.error.details,
      })
    }
    return envelope.result
  }

  async function runAcpPrompt(
    input: Record<string, unknown>,
    emit: ((update: AcpUpdate) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const courseId = typeof input['courseId'] === 'string' ? input['courseId'] : ''
    const message = typeof input['message'] === 'string'
      ? input['message']
      : typeof input['prompt'] === 'string' ? input['prompt'] : ''
    if (courseId === '' || message.trim() === '') throw new AcpProtocolError(-32602, 'courseId and message are required')
    const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : null
    const mode = input['mode'] === 'quick' || input['mode'] === 'feynman' || input['mode'] === 'debug' ? input['mode'] : 'socratic'
    const streaming = input['stream'] === true
    const requestedAfterSeq = typeof input['afterSeq'] === 'number' && Number.isInteger(input['afterSeq']) && input['afterSeq'] >= 0 ? input['afterSeq'] : 0
    const config = await configFacts()
    let resolvedSessionId = sessionId
    // Streaming clients already receive visible chat events as updates. Capture
    // the durable sequence boundary before the turn; terminal replay retains
    // only diagnostic/projection rows that did not have a live counterpart.
    // Aggregate requests keep the full replay contract and use afterSeq.
    let replayAfterSeq = requestedAfterSeq
    if (streaming && resolvedSessionId !== null) {
      replayAfterSeq = Math.max(replayAfterSeq, (await sessionEvents(registry.lastOpenedPath, courseId, resolvedSessionId, 0)).lastSeq)
    }
    let capturedNewSessionBoundary = false
    const emitFrame = (update: Record<string, unknown>): void => {
      emit?.({ sessionId: resolvedSessionId, kind: String(update['kind'] ?? 'sync'), ...update })
    }
    for await (const frame of chatStream(registry.lastOpenedPath, courseId, {
      ...(resolvedSessionId === null ? {} : { sessionId: resolvedSessionId }),
      message,
      mode,
      ...(typeof input['conceptId'] === 'string' ? { conceptId: input['conceptId'] } : {}),
      ...(Array.isArray(input['fileRefs']) ? { fileRefs: input['fileRefs'].filter((value): value is string => typeof value === 'string') } : {}),
      ...(typeof input['effort'] === 'string' ? { effort: input['effort'] } : {}),
      ...(typeof input['requestId'] === 'string' ? { requestId: input['requestId'] } : {}),
      ...(signal === undefined ? {} : { signal }),
    }, config, agentRegistry, agentService.approvals)) {
      if (frame.kind === 'meta') {
        resolvedSessionId = String(frame.payload['sessionId'] ?? resolvedSessionId ?? '') || null
        if (streaming && sessionId === null && !capturedNewSessionBoundary && resolvedSessionId !== null) {
          replayAfterSeq = Math.max(replayAfterSeq, (await sessionEvents(registry.lastOpenedPath, courseId, resolvedSessionId, 0)).lastSeq)
          capturedNewSessionBoundary = true
        }
      }
      if (frame.kind === 'error') emitFrame({ kind: 'error', code: frame.code, message: frame.message })
      else if (frame.kind === 'meta') emitFrame({ kind: 'meta', ...frame.payload })
      else if (frame.kind === 'tool-start') emitFrame({ kind: 'tool/start', ...frame.payload })
      else if (frame.kind === 'tool') emitFrame({ kind: 'tool/result', ...frame.payload })
      else if (frame.kind === 'thinking') emitFrame({ kind: 'assistant/reasoning', delta: frame.delta })
      else if (frame.kind === 'token') emitFrame({ kind: 'assistant/delta', delta: frame.delta })
      else if (frame.kind === 'ask') emitFrame({ kind: 'ask', question: frame.question })
      else emitFrame({ kind: 'sync', ...frame.payload })
    }
    const replay = resolvedSessionId === null
      ? { events: [], lastSeq: 0 }
      : await sessionEvents(registry.lastOpenedPath, courseId, resolvedSessionId, streaming ? replayAfterSeq : requestedAfterSeq)
    // These durable rows already correspond to ordered `session/update`
    // frames. Replaying them after a streaming request would duplicate message
    // content and ToolRows in ACP clients. Keep lifecycle/usage rows available
    // for trajectory inspectors and retain unfiltered replay for JSON requests.
    const liveEventTypes = new Set([
      'session/meta',
      'session/model',
      'request/header',
      'prompt/assembled',
      'user/input',
      'assistant/reasoning',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'ask/pending',
      'sync/applied',
      'turn/error',
    ])
    const replayEvents = streaming ? replay.events.filter(event => !liveEventTypes.has(event.type)) : replay.events
    for (const event of replayEvents) emitFrame({ kind: 'session/replay', event })
    const usage = resolvedSessionId === null
      ? {}
      : await agentService.projection(`study-${resolvedSessionId}`).then(projection => projection.usage).catch(() => ({}))
    return { sessionId: resolvedSessionId, events: replayEvents, lastSeq: replay.lastSeq, usage }
  }

  const acpHost: AcpHost = {
    initialize: () => ({
      protocolVersion: 1,
      serverInfo: { name: 'studyclaw', version: '0.1.0' },
      capabilities: { sessions: true, prompt: true, replay: true, cancellation: true, approvals: true, models: true },
    }),
    createSession: params => acpCall('agents.create', params),
    resumeSession: params => acpCall('agents.resume', params),
    forkSession: params => acpCall('sessions.fork', params),
    replaySession: params => acpCall('sessions.events', params),
    prompt: (params, emit, signal) => runAcpPrompt(params, emit, signal),
    cancel: params => {
      const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : typeof params['id'] === 'string' ? params['id'] : null
      if (requestId !== null) acpRequests.get(requestId)?.abort('cancelled')
      const agentId = typeof params['agentId'] === 'string' ? params['agentId'] : `study-${String(params['sessionId'] ?? '')}`
      return acpCall('agents.cancel', { ...params, agentId })
    },
    answer: params => acpCall('agents.answer', params),
    listAgents: params => acpCall('agents.list', params),
    statusAgent: params => acpCall('agents.status', params),
    whenIdle: params => acpCall('agents.whenIdle', params),
    maintenance: params => acpCall('agents.maintenance', params),
    maintenanceJobs: params => acpCall('agents.maintenanceJobs', params),
    disposeAgent: params => acpCall('agents.dispose', params),
    projection: params => acpCall('agents.projection', params),
    listModels: params => acpCall('sessions.models', params),
    selectModel: params => acpCall('sessions.selectModel', params),
    listApprovals: params => acpCall('approvals.list', params),
    resolveApproval: params => acpCall('approvals.resolve', params),
    getPlan: params => acpCall('plans.get', params),
    updatePlan: params => acpCall('plans.update', params),
    getTodo: params => acpCall('todos.get', params),
    updateTodo: params => acpCall('todos.update', params),
  }
  const acpRouter = new AcpRouter(acpHost)

  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `method ${request.method ?? ''} is not supported`, details: null } }))
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/health') {
      response.writeHead(200)
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      response.writeHead(404)
      response.end(JSON.stringify({ error: { code: 'method-not-found', message: `no such endpoint '${url.pathname}'`, details: null } }))
      return
    }
    const method = url.pathname.slice('/api/'.length)
    const uploadMatch = /^courses\/([^/]+)\/sources$/.exec(method)
    if (uploadMatch !== null) {
      void handleUpload(request, response, decodeURIComponent(uploadMatch[1]!))
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      void (async () => {
        try {
          if (method === 'chat/stream') {
            await handleChatStream(request, response, body)
            return
          }
          if (method === 'agents/answer/stream') {
            await handleAgentAnswerStream(request, response, body)
            return
          }
          // 评测提交：Web 客户端用斜杠 `eval/submit`，CLI 自带命令用点号 `eval.submit`，
          // 两种形式都路由到同一处理函数（保持向后兼容，修复 Quiz SSE 断路）。
          if (method === 'eval.submit' || method === 'eval/submit') {
            await handleEvalSubmit(response, body)
            return
          }
          if (method === 'acp') {
            await handleAcp(request, response, body)
            return
          }
          let payload: unknown
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body) as { payload?: unknown }
            payload = parsed.payload
          } catch {
            response.writeHead(400)
            response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'request body is not valid JSON', details: null } }))
            return
          }
          const envelope = await dispatch(method, payload, services)
          response.writeHead(200)
          response.end(JSON.stringify(envelope))
        } catch (error) {
          // Every request must receive a JSON envelope. A native picker or a
          // newly added service can reject outside dispatch; without this
          // boundary catch Next reports a misleading HTTP 500/socket hangup.
          console.error(`[studyclaw] rpc ${method} 失败:`, error)
          if (response.writableEnded || response.destroyed) return
          const message = error instanceof Error ? error.message : String(error)
          response.writeHead(500)
          response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message, details: null } }))
        }
      })()
    })
  })

  /** Minimal DSH-compatible JSON-RPC/ACP bridge. It delegates every method to Host dispatch. */
  async function handleAcp(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const abortController = new AbortController()
    request.once('aborted', () => abortController.abort('client'))
    request.once('close', () => { if (!response.writableEnded) abortController.abort('client') })
    let rpcRequest: AcpRequest
    try { rpcRequest = parseAcpRequest(JSON.parse(body === '' ? '{}' : body) as unknown) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -32700
      const message = error instanceof Error ? error.message : 'Parse error'
      response.writeHead(400); response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } })); return
    }
    const id = rpcRequest.id ?? null
    const method = typeof rpcRequest.method === 'string' ? rpcRequest.method : ''
    const params = rpcRequest.params
    if (method === 'initialize' || method === 'protocol.initialize') {
      const routed = await acpRouter.handle(rpcRequest, { signal: abortController.signal })
      response.writeHead(200)
      response.end(JSON.stringify(routed))
      return
    }
    const isPrompt = method === 'session.prompt' || method === 'session.send' || method === 'prompt'
    const input = typeof params === 'object' && params !== null ? params as Record<string, unknown> : {}
    const stream = isPrompt && (input['stream'] === true || String(request.headers.accept ?? '').includes('application/x-ndjson'))
    const requestKey = isPrompt && id !== null ? String(id) : null
    if (requestKey !== null) acpRequests.set(requestKey, abortController)
    if (stream) {
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
    }
    const updates: AcpNotification[] = []
    const routed = await acpRouter.handle(rpcRequest, {
      signal: abortController.signal,
      emit: notification => {
        if (stream && !response.writableEnded && !response.destroyed) {
          response.write(`${JSON.stringify(notification)}\n`)
        } else updates.push(notification)
      },
    })
    if (requestKey !== null) acpRequests.delete(requestKey)
    if (stream) {
      if (!response.writableEnded && !response.destroyed) response.end(`${JSON.stringify(routed)}\n`)
      return
    }
    const responseWithUpdates = !isPrompt || routed.error !== undefined
      ? routed
      : { ...routed, result: { ...(typeof routed.result === 'object' && routed.result !== null ? routed.result as Record<string, unknown> : {}), updates } }
    response.writeHead(200)
    response.end(JSON.stringify(responseWithUpdates))
  }

  /** `POST /api/courses/<id>/sources` (multipart): save files into sources/, then sync-build. */
  async function handleUpload(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, courseId: string): Promise<void> {
    const { default: Busboy } = await import('busboy')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = registry.lastOpenedPath
    if (root === '') {
      response.writeHead(409)
      response.end(JSON.stringify({ error: { code: 'workspace-not-found', message: '尚未打开工作区', details: null } }))
      return
    }
    const sourcesDir = join(root, 'sources')
    await mkdir(sourcesDir, { recursive: true })
    const added: string[] = []
    let uploadError: Error | null = null
    try {
      const busboy = Busboy({ headers: request.headers })
      busboy.on('file', (_name, stream, info) => {
        const filename = info.filename.split(/[\\/]/).pop() ?? 'upload.txt'
        const safe = filename.replace(/[^\w.\u4e00-\u9fff-]/g, '_').slice(0, 120)
        const path = join(sourcesDir, safe)
        const chunks: Buffer[] = []
        stream.on('data', chunk => chunks.push(chunk as Buffer))
        stream.on('end', () => { void writeFile(path, Buffer.concat(chunks)) })
        added.push(safe)
      })
      busboy.on('error', (error: Error) => { uploadError = error })
      request.pipe(busboy)
      await new Promise<void>(resolve => busboy.on('close', resolve))
    } catch (error) {
      uploadError = error instanceof Error ? error : new Error(String(error))
    }
    if (uploadError !== null) {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: `上传失败: ${uploadError.message}`, details: null } }))
      return
    }
    let buildJobId: string | null = null
    try {
      const config = await configFacts()
      if (config !== null && config.model !== '' && config.baseUrl !== '') {
        // 上传后直接同步构建（异步 job 路径由 sync 端点覆盖）
        await services.courseService.sync(courseId)
      }
    } catch {
      // Build failure does not fail the upload itself.
    }
    response.writeHead(200)
    response.end(JSON.stringify({ added, buildJobId }))
  }

  /** `POST /api/eval.submit` (SSE): scan / rubric×N / result / sm2 / done frames. */
  async function handleEvalSubmit(response: import('node:http').ServerResponse, body: string): Promise<void> {
    let input: { courseId?: unknown; taskId?: unknown; answer?: unknown; sessionId?: unknown }
    try {
      input = JSON.parse(body === '' ? '{}' : body) as typeof input
    } catch {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'request body is not valid JSON', details: null } }))
      return
    }
    const courseId = typeof input.courseId === 'string' ? input.courseId : ''
    const taskId = typeof input.taskId === 'string' ? input.taskId : ''
    const answer = typeof input.answer === 'string' ? input.answer : ''
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null
    if (courseId === '' || taskId === '' || answer === '') {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'courseId/taskId/answer are required', details: null } }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    const writeFrame = (event: string, data: unknown): void => {
      if (response.writableEnded || response.destroyed) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      for await (const frame of services.courseService.evalSubmit(courseId, taskId, answer, sessionId)) {
        const event = String(frame['event'] ?? '')
        writeFrame(event, frame['data'])
      }
    } catch (error) {
      writeFrame('error', { code: 'EVAL_FAILED', message: error instanceof Error ? error.message : String(error) })
    }
    response.end()
  }

  /**
   * `POST /api/chat/stream` (SSE): one chat turn over the active workspace's
   * course. Frames: meta / thinking / token / tool / ask / sync / done / error.
   * Client disconnect stops the write side; the turn keeps persisting.
   */
  async function handleChatStream(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const abortController = new AbortController()
    request.once('aborted', () => abortController.abort('client'))
    request.once('close', () => { if (!response.writableEnded) abortController.abort('client') })
    let input: { courseId?: unknown; message?: unknown; mode?: unknown; sessionId?: unknown; turnId?: unknown; conceptId?: unknown; fileRefs?: unknown; effort?: unknown; requestId?: unknown }
    try {
      const parsed = JSON.parse(body === '' ? '{}' : body) as typeof input
      input = parsed
    } catch {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'request body is not valid JSON', details: null } }))
      return
    }
    const courseId = typeof input.courseId === 'string' ? input.courseId : ''
    const message = typeof input.message === 'string' ? input.message : ''
    const queuedTurnId = typeof input.turnId === 'string' ? input.turnId : ''
    if (courseId === '' || (message.trim() === '' && queuedTurnId === '')) {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'courseId and message are required', details: null } }))
      return
    }
    const workspaceRoot = registry.lastOpenedPath
    if (workspaceRoot === '') {
      response.writeHead(409)
      response.end(JSON.stringify({ error: { code: 'workspace-not-found', message: '尚未打开工作区', details: null } }))
      return
    }
    const config = await loadChatConfig(workspaceRoot).catch(() => null)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    const writeFrame = (event: string, data: unknown): void => {
      if (response.writableEnded || response.destroyed) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const mode = typeof input.mode === 'string' && ['socratic', 'quick', 'feynman', 'debug'].includes(input.mode)
      ? input.mode as LearningMode
      : 'socratic'
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null
    let resolvedSessionId = sessionId
    const conceptId = typeof input.conceptId === 'string' ? input.conceptId : null
    const fileRefs = Array.isArray(input.fileRefs) ? input.fileRefs.filter((ref): ref is string => typeof ref === 'string') : []
    if (queuedTurnId !== '') {
      if (sessionId === null) { writeFrame('error', { code: 'invalid-request', message: 'queued turn requires sessionId' }); writeFrame('done', { usage: {}, turnId: sessionId }); response.end(); return }
      for await (const event of agentService.queuedEvents(`study-${sessionId}`, queuedTurnId, abortController.signal)) {
        const payload = event.payload ?? {}
        if (event.type === 'session/meta') writeFrame('meta', payload)
        else if (event.type === 'assistant/reasoning') writeFrame('thinking', { delta: String(payload['delta'] ?? '') })
        else if (event.type === 'assistant/chunk') writeFrame('token', { delta: String(payload['delta'] ?? '') })
        else if (event.type === 'tool/call') writeFrame('tool-start', payload)
        else if (event.type === 'tool/result') writeFrame('tool', payload)
        else if (event.type === 'ask/pending') writeFrame('ask', { question: String(payload['question'] ?? '') })
        else if (event.type === 'sync/applied') writeFrame('sync', payload)
        else if (event.type === 'turn/error') writeFrame('error', { code: 'AGENT_TURN_FAILED', message: String(payload['message'] ?? '') })
      }
      const usage = await agentService.projection(`study-${sessionId}`).then(projection => projection.usage).catch(() => ({}))
      writeFrame('done', { usage, turnId: queuedTurnId }); response.end(); return
    }
    for await (const event of chatStream(workspaceRoot, courseId, {
      sessionId,
      message,
      mode,
      conceptId,
      fileRefs,
      ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
      ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {}),
      signal: abortController.signal,
    }, config, agentRegistry, agentService.approvals)) {
      if (event.kind === 'meta') {
        resolvedSessionId = String(event.payload['sessionId'] ?? resolvedSessionId ?? '') || null
        writeFrame('meta', event.payload)
      } else if (event.kind === 'error') {
        writeFrame('error', { code: event.code, message: event.message })
      } else if (event.kind === 'sync') {
        writeFrame('sync', event.payload)
      } else if (event.kind === 'tool-start') {
        writeFrame('tool-start', event.payload)
      } else if (event.kind === 'tool') {
        writeFrame('tool', event.payload)
      } else if (event.kind === 'ask') {
        writeFrame('ask', { question: event.question })
      } else {
        writeFrame(event.kind, { delta: event.delta })
      }
    }
    const completedSessionId = resolvedSessionId
    const usage = completedSessionId === null ? {} : await agentService.projection(`study-${completedSessionId}`).then(projection => projection.usage).catch(() => ({}))
    writeFrame('done', { usage, turnId: completedSessionId })
    response.end()
  }

  /** `POST /api/agents/answer/stream` resumes one durable ask turn. */
  async function handleAgentAnswerStream(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string): Promise<void> {
    const abortController = new AbortController()
    request.once('aborted', () => abortController.abort('client'))
    request.once('close', () => { if (!response.writableEnded) abortController.abort('client') })
    let input: { agentId?: unknown; answer?: unknown }
    try { input = JSON.parse(body === '' ? '{}' : body) as typeof input } catch {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'request body is not valid JSON', details: null } }))
      return
    }
    const agentId = typeof input.agentId === 'string' ? input.agentId : ''
    const answer = typeof input.answer === 'string' ? input.answer : ''
    if (agentId === '' || answer.trim() === '') {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'agentId and answer are required', details: null } }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    const writeFrame = (event: string, data: unknown): void => {
      if (response.writableEnded || response.destroyed) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      const queued = await agentService.answer(agentId, answer)
      const turnId = String(queued['turnId'] ?? '')
      for await (const event of agentService.answerEvents(agentId, turnId, abortController.signal)) {
        const payload = event.payload ?? {}
        if (event.type === 'session/meta') writeFrame('meta', payload)
        else if (event.type === 'assistant/reasoning') writeFrame('thinking', { delta: String(payload['delta'] ?? '') })
        else if (event.type === 'assistant/chunk') writeFrame('token', { delta: String(payload['delta'] ?? '') })
        else if (event.type === 'tool/call') writeFrame('tool-start', payload)
        else if (event.type === 'tool/result') writeFrame('tool', payload)
        else if (event.type === 'ask/pending') writeFrame('ask', { question: String(payload['question'] ?? '') })
        else if (event.type === 'sync/applied') writeFrame('sync', payload)
        else if (event.type === 'turn/error') writeFrame('error', { code: 'AGENT_TURN_FAILED', message: String(payload['message'] ?? '') })
      }
    } catch (error) {
      writeFrame('error', { code: 'AGENT_ANSWER_FAILED', message: error instanceof Error ? error.message : String(error) })
    }
    writeFrame('done', { usage: {}, turnId: agentId })
    response.end()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      console.log(`[studyclaw] host listening on http://127.0.0.1:${port} (home: ${hostHome()})`)
      resolve()
    })
  })

  const shutdown = async (): Promise<void> => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await ctx.fiber.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/** `studyclaw status`: print the workspace, courses, and progress summaries. */
async function status(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: hostHome() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const root = ctx.workspaceRegistry.lastOpenedPath
  await ctx.fiber.dispose()
  if (root === '') {
    console.log('尚未打开工作区（studyclaw serve 后从 WebUI 导入）')
    return
  }
  console.log(`工作区：${root}`)
  const { listCourseSummaries } = await import('@studyclaw/course-summary')
  const { courses } = await listCourseSummaries(root)
  for (const course of courses) {
    console.log(
      `  📚 ${course.title}（${course.id}） 掌握度 ${Math.round(course.overallMastery * 100)}% · 到期 ${course.dueToday}`,
    )
  }
}

/** Explicitly migrate legacy JSONL sessions into Agent event logs. */
async function migrateSessions(sessionId?: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: hostHome() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const root = ctx.workspaceRegistry.lastOpenedPath
  await ctx.fiber.dispose()
  if (root === '') throw new Error('尚未打开工作区')
  const { courses } = await listCourseSummaries(root)
  let count = 0
  for (const course of courses) {
    const sessions = await listSessions(root, course.id)
    for (const session of sessions) {
      if (sessionId !== undefined && session.sessionId !== sessionId) continue
      const result = await migrateLegacySession(join(root, 'history'), session.sessionId)
      if (result.migrated) count += 1
      console.log(`${result.migrated ? '已迁移' : '已存在'} ${course.id}/${session.sessionId} (${result.events} events)`)
    }
  }
  console.log(`迁移完成：${count} 个会话`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === 'serve') {
    const portFlag = args.indexOf('--port')
    const port = portFlag >= 0 && args[portFlag + 1] ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 8080)
    await serve(Number.isFinite(port) ? port : 8080)
  } else if (command === 'status') {
    await status()
  } else if (command === 'session' && args[1] === 'migrate') {
    await migrateSessions(args[2])
  } else if (command === 'agent') {
    await agentCommand(args)
  } else if (command === 'approvals') {
    await approvalsCommand(args)
  } else if (command === 'plan' || command === 'todo') {
    await planTodoCommand(command, args)
  } else if (command === 'acp') {
    await acpStdio()
  } else if (command === 'quiz') {
    await quizCommand(args.slice(1))
  } else if (command === 'review') {
    await reviewCommand(args.slice(1))
  } else if (command === 'chat') {
    await chatCommand(args.slice(1))
  } else {
    usage()
    process.exit(command === '--help' ? 0 : 1)
  }
}

main().catch(error => {
  if (error instanceof UsageError) {
    console.error(`× ${error.message}`)
    process.exit(2)
  }
  console.error(`× ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
