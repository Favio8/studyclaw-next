#!/usr/bin/env node
/**
 * StudyClaw CLI entry (M1): `studyclaw serve` runs the host — cordis
 * assembly (storage + workspace registry) and a node:http server that
 * dispatches the RPC method table over `POST /api/<method>`.
 *
 * Dev mode runs this through tsx; the packaged npm bin (M5) runs the tsdown
 * build of this same entry.
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@studyclaw/workspace'
import { AcpProtocolError, AcpRouter, parseAcpRequest, type AcpHost, type AcpNotification, type AcpRequest, type AcpUpdate } from '@studyclaw/acp'
import { listCourseSummaries } from '@studyclaw/course-summary'
import { migrateLegacyLayout, stateDirOf } from '@studyclaw/course-builder'
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
  agentEventToFrame,
  LearningAgentService,
} from '@studyclaw/chat-service'
import { migrateLegacySession } from '@studyclaw/session'
import type { LearningMode } from '@studyclaw/session'
import { createCourseService } from '@studyclaw/chat-service'
import { AgentRegistry } from '@studyclaw/agent'
import { hostRpc, authHeaders, defaultClientDeps } from './lib/client.ts'
import { UsageError } from './lib/args.ts'
import { isLoopbackOrigin, PayloadTooLargeError, readRequestBody, RequestBodyTimeoutError, sanitizeErrorMessage } from './lib/http-guards.ts'
import { installHostFileLogging } from './lib/host-logger.ts'
import { createStaticHost } from './lib/static-host.ts'
import type { StaticHost } from './lib/static-host.ts'
import { quizCommand } from './commands/quiz.ts'
import { reviewCommand } from './commands/review.ts'
import { chatCommand } from './commands/chat.ts'
import { syncCommand } from './commands/sync.ts'
import { courseCommand } from './commands/course.ts'

function hostHome(): string {
  // NEW-007：env 覆盖先 resolve 成绝对路径（相对路径以进程 cwd 锚定），
  // 避免宿主与 CLI/桌面端 cwd 不同时，配置与锁文件落到不可预期的位置。
  const override = process.env.STUDYCLAW_HOME
  if (override !== undefined && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.studyclaw')
}

/** FL-03：设置读写以 lastOpenedPath 为根；未打开工作区时配置会写到宿主进程
 * cwd 的游离 `.studyclaw/`（假成功 + 重启失忆）。落盘前必须先有工作区。 */
function requireWorkspaceRootForSettings(root: string, action: string): void {
  if (root === '') {
    throw new Error(`请先在左栏添加/打开一个项目，再${action}（当前没有已打开的工作区，配置无处落盘）`)
  }
}

/** FL-41：宿主单实例锁（`<hostHome>/host.lock` 记 pid + port）。持有者进程
 * 存活 → 拒绝启动并给出可读提示；进程已死（崩溃残留）→ 自愈抢走。 */
interface HostInstanceLock {
  release(): void
}

async function acquireHostInstanceLock(port: number): Promise<HostInstanceLock> {
  const { open, readFile, rm } = await import('node:fs/promises')
  const lockPath = join(hostHome(), 'host.lock')
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const raw = await readFile(lockPath, 'utf8').catch(() => '')
      let holder: { pid?: number; port?: number } = {}
      try {
        holder = JSON.parse(raw) as { pid?: number; port?: number }
      } catch {
        // 锁内容损坏按陈旧处理（pid 解析失败 → 抢走）。
      }
      const pid = Number(holder.pid)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new Error(`已有 StudyClaw 宿主实例在运行（PID ${pid}${holder.port === undefined ? '' : `，端口 ${holder.port}`}）。请勿多开实例；确认没有实例在运行后可删除 ${lockPath} 再试。`)
      }
      await rm(lockPath, { force: true })
      continue
    }
    try {
      await handle.write(JSON.stringify({ pid: process.pid, port }), 0)
    } finally {
      await handle.close().catch(() => undefined)
    }
    const release = (): void => { void rm(lockPath, { force: true }).catch(() => undefined) }
    process.on('exit', release)
    return { release }
  }
}

/** FL-30/35：宿主发现文件（`<hostHome>/host.json`）——记录实际端口与访问
 * token，桌面端/CLI 客户端据此握手。token 为 null 表示 `--insecure-no-token`。 */
async function writeHostConfig(port: number, token: string | null): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(hostHome(), 'host.json'),
    JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  )
}

function removeHostConfig(): void {
  void import('node:fs/promises').then(({ rm }) => rm(join(hostHome(), 'host.json'), { force: true }).catch(() => undefined))
}

/** 常数时间比较（先定长哈希，规避长度/时序侧信道）。 */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  )
}

/** 从请求提取 token：`Authorization: Bearer` / `x-studyclaw-token` / `?token=`。 */
function requestToken(request: import('node:http').IncomingMessage, url: URL): string {
  const auth = request.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const header = request.headers['x-studyclaw-token']
  if (typeof header === 'string' && header.trim() !== '') return header.trim()
  return url.searchParams.get('token')?.trim() ?? ''
}

/** H-1：agentEventToFrame 的产物 → SSE（帧名，data 负载）。chat/stream 的
 * 三条事件源（chatStream 主路径、queuedEvents 队列消费、ask 幂等重放）共用
 * 这一个形状函数，杜绝内联 if 链副本再漂移（此前两份副本缺 turn/cancelled
 * → TURN_CANCELLED，取消回合被 done 帧错误闭环为成功）。 */
function frameToSseData(frame: NonNullable<ReturnType<typeof agentEventToFrame>>): { event: string; data: unknown } {
  if (frame.kind === 'thinking' || frame.kind === 'token') return { event: frame.kind, data: { delta: frame.delta } }
  if (frame.kind === 'ask') return { event: 'ask', data: { question: frame.question } }
  if (frame.kind === 'error') return { event: 'error', data: { code: frame.code, message: frame.message } }
  return { event: frame.kind, data: frame.payload }
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
 * page. `null` lists the roots page.
 *
 * FL-02：首启（尚无工作区）时 browse 是唯一的项目选择途径——原生选择器仅
 * Windows 可用，而旧实现 browse 又要求"已打开工作区"，非 Windows 首启无任何
 * 添加项目途径（整链断裂）。放开为：无工作区时全盘浏览（DSH
 * directory-picker-browse 语义，仍受 POST + loopback Origin 门禁保护）；
 * 已打开工作区后保持 SEC-5 收紧——只允许浏览当前工作区内部。
 */
async function browseLocalDirectory(
  requested: string | null | undefined,
  workspaceRoot: string,
): Promise<DirectoryBrowseResult> {
  const { readdir } = await import('node:fs/promises')
  if (workspaceRoot === '') {
    const requestedTrimmed = requested === null || requested === undefined ? '' : requested.trim()
    if (requestedTrimmed === '') {
      return { path: '', parent: null, entries: await listRootEntries(readdir) }
    }
    const canonical = await realpath(requestedTrimmed).catch(() => null)
    if (canonical === null) throw new Error('目标路径不存在或不可访问')
    const info = await stat(canonical).catch(() => null)
    if (info === null || !info.isDirectory()) throw new Error('目标路径不是文件夹')
    return { path: canonical, parent: dirname(canonical), entries: await browseWorkspaceChildren(canonical, readdir) }
  }
  const requestedTrimmed = requested === null || requested === undefined ? '' : requested.trim()
  if (requestedTrimmed === '') {
    const entries: DirectoryEntry[] = []
    for (const entry of await browseWorkspaceChildren(workspaceRoot, readdir)) entries.push(entry)
    return { path: workspaceRoot, parent: null, entries }
  }
  // 以工作区为唯一根：`..`、盘符切换等路径在 realpath 前先做前缀校验。
  const candidate = join(workspaceRoot, requestedTrimmed)
  const canonical = await realpath(candidate).catch(() => null)
  if (canonical === null || !isInsideRoot(workspaceRoot, canonical)) {
    throw new Error('目标路径不在当前工作区内')
  }
  let stats
  try {
    stats = await stat(canonical)
  } catch {
    throw new Error('目标路径不存在或不可访问')
  }
  if (!stats.isDirectory()) throw new Error('目标路径不是文件夹')
  const entries: DirectoryEntry[] = await browseWorkspaceChildren(canonical, readdir)
  return { path: canonical, parent: dirname(canonical), entries }
}

/** FL-02：首启全盘浏览的根页——Windows 枚举盘符，POSIX 列根目录一级。 */
async function listRootEntries(
  readdir: typeof import('node:fs/promises').readdir,
): Promise<DirectoryEntry[]> {
  if (process.platform === 'win32') {
    const entries: DirectoryEntry[] = []
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`
      if ((await stat(drive).catch(() => null))?.isDirectory()) entries.push({ name: drive, path: drive })
    }
    return entries
  }
  const children = await readdir('/', { withFileTypes: true }).catch(() => [])
  return children
    .filter(entry => entry.isDirectory() && !BROWSE_HIDDEN.has(entry.name) && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join('/', entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  if (normalizedCandidate === normalizedRoot) return true
  return normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

async function browseWorkspaceChildren(
  dir: string,
  readdir: typeof import('node:fs/promises').readdir,
): Promise<DirectoryEntry[]> {
  const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return children
    .filter(entry => entry.isDirectory() && !BROWSE_HIDDEN.has(entry.name))
    .map(entry => ({ name: entry.name, path: join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/** 单文件/单次上传的体积与数量上限（P1-5：此前完全无上限，10MB body 直接吃进内存）。 */
const UPLOAD_FILE_LIMIT_BYTES = 25 * 1024 * 1024
const UPLOAD_MAX_FILES = 10

/**
 * 在 dir 内为 filename 找一个不冲突的名字：重名追加 -1/-2 序号而不是覆盖。
 * L10：目标名以 `wx` 独占创建空文件预留——旧「readdir 查重 → rename」的检查-
 * 使用窗口内，并发上传可能选中同一名字并静默互覆；预留后并发方立刻 EEXIST
 * 递增序号。调用方必须向返回路径写入（rename 覆盖空文件），失败时清理它。
 */
async function uniqueDestinationPath(dir: string, filename: string): Promise<string> {
  const { open } = await import('node:fs/promises')
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let candidate = filename
  let index = 1
  for (;;) {
    const probe = join(dir, candidate)
    try {
      const handle = await open(probe, 'wx')
      await handle.close()
      return probe
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    candidate = `${stem}-${index}${ext}`
    index += 1
  }
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
  console.log('usage: studyclaw serve [--port <n>] [--open] [--insecure-no-token] | status | course <list|show> [<courseId>] | sync [--course <id>] | session migrate [<sessionId>] | quiz [count] [--mode new|review] [--course <id>] [--concept <id>] | review [count] [--course <id>] [--concept <id>] | chat [message] [--mode socratic|quick|feynman|debug] [--course <id>] [--session <id>] [--new] [--concept <id>] [--turns N] | agent <create|resume|prompt|send|answer|status|cancel|whenIdle|maintenance|maintenance-jobs|dispose> | approvals <list|resolve> | plan <get|update> | todo <get|update> | acp')
}

function hostUrl(): string {
  // FL-35：显式 env 最高优先；否则随 client.ts 从 host.json 自动发现实际端口。
  if (process.env.STUDYCLAW_HOST_URL !== undefined) return process.env.STUDYCLAW_HOST_URL.replace(/\/$/, '')
  return defaultClientDeps().baseUrl
}

async function acpRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${hostUrl()}/api/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(defaultClientDeps()) },
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
        headers: { 'content-type': 'application/json', ...authHeaders(defaultClientDeps()), ...(wantsStream ? { accept: 'application/x-ndjson' } : {}) },
        body: JSON.stringify(outgoing),
      })
      process.stdout.write(`${await response.text()}\n`)
    } catch (error) {
      const code = error instanceof AcpProtocolError ? error.code : -32603
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`)
    }
  }
}

export interface ServeOptions {
  /** FL-30：跳过 token 校验（逃生口；host.json 的 token 记为 null）。 */
  insecureNoToken?: boolean
  /** FL-21：listen 成功后自动打开系统浏览器。 */
  open?: boolean
}

async function serve(port: number, options: ServeOptions = {}): Promise<void> {
  // FL-37：文件日志先于任何业务逻辑安装——启动期错误也要留痕。仅 serve 安装
  //（acp/quiz 等前台命令的 stdout 是协议/交互通道，不能被日志污染）。
  const hostLogger = await installHostFileLogging(hostHome())
  // FL-41：单实例守卫。桌面端/多开场景下两个宿主同时 serve 同一工作区会
  // 交叉写 progress.md（进程内锁对跨进程无效），且用户双击两次图标会开出
  // 两个宿主。host.lock 记 pid + port，持有者存活则拒绝启动并给出可读提示。
  const instanceLock = await acquireHostInstanceLock(port)
  // FL-30：启动即生成一次性访问 token；除 /api/health 外的每个端点都要求
  // Bearer 校验（同机进程不再可无凭据调用全部 RPC）。--insecure-no-token 为
  // 显式逃生口（host.json 的 token 记 null，便于排查）。
  const token = options.insecureNoToken === true ? null : randomBytes(24).toString('hex')
  // FL-21：同端口托管 Web UI（apps/web 的静态导出产物）。产物缺失时保持
  // 纯 API 行为。token 经 index tap 注入同源页面（window.__STUDYCLAW__）。
  const staticHost: StaticHost | null = await createStaticHost({
    root: webDistRoot(),
    bootstrap: token === null ? null : { token },
  })
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
      // M4：evalId 必须透传——箭头函数实现少于接口形参是 TS 允许的，此前
      // 在这里静默丢参导致磁盘幂等账本（.studyclaw/eval-ledger/）永不写入。
      evalSubmit: (courseId, taskId, answer, sessionId, evalId) => courseService.evalSubmit(activeRoot(), courseId, taskId, answer, sessionId, evalId),
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
    browseDirectory: path => browseLocalDirectory(path, registry.lastOpenedPath),
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
      clearQueued: agentId => agentService.clearQueued(agentId),
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
      // FL-03：未打开工作区时 root 为 ''，`join('', '.studyclaw', 'config.yaml')`
      // 会落在宿主进程 cwd——UI 报"已保存"但配置写飞，重启即失忆。所有落盘
      // 操作必须先有工作区。
      get: async () => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '读取设置'); return settingsPayload(registry.lastOpenedPath) as unknown as Record<string, unknown> },
      update: async partial => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '更新设置'); return updateSettings(registry.lastOpenedPath, partial) as unknown as Record<string, unknown> },
      catalog: async () => providerCatalog() as unknown as Array<Record<string, unknown>>,
      // M6：设置页「从端点获取」永远实时探测；sessionModels 的自动发现才走缓存。
      discover: async input => discoverModels({ ...input, refresh: true }) as unknown as Array<Record<string, unknown>>,
      save: async input => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '保存模型供应商'); return saveProvider(registry.lastOpenedPath, input as Parameters<typeof saveProvider>[1]) as unknown as Record<string, unknown> },
      remove: async providerId => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '删除模型供应商'); return deleteProvider(registry.lastOpenedPath, providerId) as unknown as Record<string, unknown> },
      activate: async providerId => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '激活模型供应商'); return activateProvider(registry.lastOpenedPath, providerId) as unknown as Record<string, unknown> },
      credential: async (providerId, apiKey) => { requireWorkspaceRootForSettings(registry.lastOpenedPath, '保存 API Key'); return setCredential(registry.lastOpenedPath, providerId, apiKey) as unknown as Record<string, unknown> },
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
    const url = new URL(request.url ?? '/', 'http://localhost')
    // 健康探针最先放行：标准 LB/容器探针用 GET/HEAD，不能被 POST 守卫拦成 405。
    if (url.pathname === '/api/health') {
      response.writeHead(200)
      response.end(JSON.stringify({ ok: true }))
      return
    }
    // 本地源门禁：浏览器跨站请求必带 Origin 且页面脚本无法伪造，无 Origin 的
    // curl/CLI 不受限。dev 前端经 Next 代理透传 localhost Origin。去掉通配
    // CORS 后，恶意网页既无法预检通过也无法读取响应（drive-by 关闭，SEC-1）。
    if (!isLoopbackOrigin(request.headers.origin)) {
      response.writeHead(403)
      response.end(JSON.stringify({ error: { code: 'cross-origin-forbidden', message: 'cross-origin requests are not allowed', details: null } }))
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    // FL-30：token 门禁——/api/*（health 已放行）之外的一切 API 端点都要求
    // 持有宿主签发的 token；静态资源（UI 资产）不设 token，公开可读。
    if (url.pathname.startsWith('/api/') && token !== null && !tokenMatches(requestToken(request, url), token)) {
      response.writeHead(401)
      response.end(JSON.stringify({ error: { code: 'unauthorized', message: `缺少或错误的访问令牌（token 记录于 ${join(hostHome(), 'host.json')}，请求头 Authorization: Bearer <token>）`, details: null } }))
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      // FL-21：非 /api 的 GET/HEAD 交给静态托管（Web UI）；/api 的 GET 仍 405。
      if (!url.pathname.startsWith('/api/') && staticHost !== null) {
        void (async () => {
          const hit = await staticHost.respond(url.pathname)
          if (hit === null) {
            response.writeHead(404)
            response.end(JSON.stringify({ error: { code: 'not-found', message: `no such file '${url.pathname}'`, details: null } }))
            return
          }
          response.setHeader('Content-Type', hit.contentType)
          response.writeHead(hit.status)
          response.end(request.method === 'HEAD' ? undefined : hit.body)
        })()
        return
      }
      response.writeHead(405)
      response.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `method ${request.method ?? ''} is not supported`, details: null } }))
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `method ${request.method ?? ''} is not supported`, details: null } }))
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
      // WHATWG URL 的 pathname 原样保留无效百分号序列（%ZZ、50%off），
      // decodeURIComponent 会抛 URIError——绝不能在请求监听器的同步路径上解码，
      // 否则异常升级为 uncaughtException 打崩宿主进程。
      let courseId: string
      try {
        courseId = decodeURIComponent(uploadMatch[1]!)
      } catch {
        response.writeHead(400)
        response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'courseId 含无效的百分号编码', details: null } }))
        return
      }
      void handleUpload(request, response, courseId).catch(error => {
        // 兜底边界：handleUpload 已尽力把失败写进响应，这里只接漏网异常，
        // 与主 API 分支的边界 catch 同样遵守 headersSent 限制。
        if (response.headersSent || response.writableEnded || response.destroyed) {
          response.end()
          return
        }
        console.error('[studyclaw] upload 失败:', error instanceof Error ? sanitizeErrorMessage(error.stack ?? error.message) : String(error))
        response.writeHead(500)
        response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '上传处理失败', details: null } }))
      })
      return
    }
    void (async () => {
      try {
        const body = await readRequestBody(request)
        // FL-04：这里原本包了一层 `try { ... } catch (error) { }` 的空 catch，
        // 把 `dispatch` 内部抛出的异常（而非返回的错误信封）整个吞掉：响应永不
        // `end()`，请求挂死成 socket hang up——恰好是下方边界注释声称要防的场景。
        // 去掉内层 try，让异常直接落到边界 catch，保证每个请求都有 JSON 信封。
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
        // headersSent（如 SSE 处理器已写 200 头后才抛错）时绝不能再 writeHead——
        // ERR_HTTP_HEADERS_SENT 是未捕获异常，会打崩整个 host 进程；
        // 此时只能安全地断开连接，SSE 层自己负责以 error 帧收尾。
        if (response.headersSent || response.writableEnded || response.destroyed) {
          response.end()
          return
        }
        if (error instanceof PayloadTooLargeError) {
          response.writeHead(413)
          response.end(JSON.stringify({ error: { code: error.code, message: error.message, details: null } }))
          return
        }
        if (error instanceof RequestBodyTimeoutError) {
          response.writeHead(408)
          response.end(JSON.stringify({ error: { code: error.code, message: error.message, details: null } }))
          return
        }
        // Every request must receive a JSON envelope. A native picker or a
        // newly added service can reject outside dispatch; without this
        // boundary catch Next reports a misleading HTTP 500/socket hangup.
        // BUG-005：错误消息可能内嵌 URL 凭据/厂商密钥（fetch 失败、上游 4xx
        // 回显），出日志与出 API 前先净化。日志记净化后的堆栈（栈首行即
        // message），排障信息不丢；API 响应只回净化后的单行 message。
        const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
        console.error(`[studyclaw] rpc ${method} 失败:`, error instanceof Error ? sanitizeErrorMessage(error.stack ?? error.message) : message)
        response.writeHead(500)
        response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message, details: null } }))
      }
    })()
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
    const { mkdir, rename, rm } = await import('node:fs/promises')
    const { createWriteStream } = await import('node:fs')
    const { randomUUID } = await import('node:crypto')
    const root = registry.lastOpenedPath
    if (root === '') {
      response.writeHead(409)
      response.end(JSON.stringify({ error: { code: 'workspace-not-found', message: '尚未打开工作区', details: null } }))
      return
    }
    const sourcesDir = join(root, 'sources')
    try {
      await mkdir(sourcesDir, { recursive: true })
    } catch (error) {
      response.writeHead(500)
      response.end(JSON.stringify({ error: { code: 'sources-dir-unavailable', message: `sources 目录不可用: ${error instanceof Error ? error.message : String(error)}`, details: null } }))
      return
    }
    const added: string[] = []
    const rejected: Array<{ file: string; reason: string }> = []
    // NEW-003：每个文件直接流式落盘到临时文件（pause/drain 背压限流），不再把
    // 25MB×N 并发上传整体吃进内存；全部流结算后按到达顺序原子改名转正。
    // NEW-009：busboy 中途出错会掐断在途写流并标记放弃，结算 Promise 不悬挂，
    // 临时文件就地清理。
    const pending: Array<{
      safe: string
      tmpPath: string
      skipReason: string | null
      settled: Promise<void>
      destroy: () => void
    }> = []
    let busboyError: Error | null = null
    try {
      const busboy = Busboy({
        headers: request.headers,
        limits: { fileSize: UPLOAD_FILE_LIMIT_BYTES, files: UPLOAD_MAX_FILES },
      })
      busboy.on('filesLimit', () => {
        rejected.push({ file: '(后续文件)', reason: `超过单次 ${UPLOAD_MAX_FILES} 个文件的上限` })
      })
      busboy.on('file', (_name, stream, info) => {
        const filename = info.filename.split(/[\\/]/).pop() ?? 'upload.txt'
        const safe = filename.replace(/[^\w.\u4e00-\u9fff-]/g, '_').slice(0, 120) || 'upload.txt'
        const tmpPath = join(sourcesDir, `.upload-${randomUUID()}.tmp`)
        const writeStream = createWriteStream(tmpPath)
        const entry: { safe: string; tmpPath: string; skipReason: string | null; settled: Promise<void>; destroy: () => void } = {
          safe,
          tmpPath,
          skipReason: null,
          settled: Promise.resolve(),
          destroy: () => writeStream.destroy(),
        }
        entry.settled = new Promise<void>(resolve => {
          // busboy 在 fileSize 处截断并丢弃剩余字节；带 limit 标记的文件不转正。
          stream.on('limit', () => { entry.skipReason = `超过单个 ${Math.round(UPLOAD_FILE_LIMIT_BYTES / 1024 / 1024)}MB 的上限` })
          stream.on('data', chunk => {
            if (entry.skipReason !== null) return
            if (!writeStream.write(chunk as Buffer)) stream.pause()
          })
          writeStream.on('drain', () => stream.resume())
          stream.on('end', () => { writeStream.end() })
          stream.on('error', () => {
            if (entry.skipReason === null) entry.skipReason = '文件流读取失败'
            writeStream.destroy()
          })
          writeStream.on('error', () => {
            if (entry.skipReason === null) entry.skipReason = '文件落盘失败'
          })
          writeStream.on('close', resolve)
        })
        pending.push(entry)
      })
      busboy.on('error', (error: Error) => {
        busboyError = error
        for (const entry of pending) {
          if (entry.skipReason === null) entry.skipReason = `上传中断: ${error.message}`
          entry.destroy()
        }
      })
      request.pipe(busboy)
      await new Promise<void>(resolve => busboy.on('close', resolve))
      await Promise.allSettled(pending.map(entry => entry.settled))
    } catch (error) {
      busboyError = error instanceof Error ? error : new Error(String(error))
    }
    // 落盘收尾：放弃的（截断/出错/中断）临时文件就地清理；成功的原子改名到
    // 唯一目标名（重名追加 -1/-2 序号，不再静默互相覆盖）。响应在全部落盘
    // 结算后才发出，杜绝 fire-and-forget 式写盘失败既不进响应也无日志。
    for (const entry of pending) {
      if (entry.skipReason !== null) {
        await rm(entry.tmpPath, { force: true }).catch(() => undefined)
        rejected.push({ file: entry.safe, reason: entry.skipReason })
        continue
      }
      try {
        const path = await uniqueDestinationPath(sourcesDir, entry.safe)
        try {
          await rename(entry.tmpPath, path)
          added.push(path.slice(sourcesDir.length + 1))
        } catch (error) {
          // L10：rename 失败时预留的空文件一并清理。
          await rm(path, { force: true }).catch(() => undefined)
          throw error
        }
      } catch (error) {
        await rm(entry.tmpPath, { force: true }).catch(() => undefined)
        rejected.push({ file: entry.safe, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    if (busboyError !== null) {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: `上传失败: ${busboyError.message}`, details: null } }))
      return
    }
    let buildJobId: string | null = null
    let buildError: string | undefined
    try {
      const config = await configFacts()
      if (config !== null && config.model !== '' && config.baseUrl !== '') {
        // 上传后直接同步构建（异步 job 路径由 sync 端点覆盖）
        // FL-01：sync() 返回的 buildJobId 此前被丢弃——响应恒 buildJobId:null，
        // 前端 `if (buildJobId)` 轮询分支永不执行，上传后构建的进度与失败对
        // 用户完全不可见（假完成）。
        const syncResult = await services.courseService.sync(courseId)
        buildJobId = typeof syncResult['buildJobId'] === 'string' ? syncResult['buildJobId'] : null
      }
    } catch (error) {
      // Build failure does not fail the upload itself, but it must reach the
      // client instead of vanishing into a silent catch.
      buildError = error instanceof Error ? error.message : String(error)
    }
    response.writeHead(200)
    response.end(JSON.stringify(buildError === undefined && rejected.length === 0
      ? { added, buildJobId }
      : { added, buildJobId, ...(buildError !== undefined ? { buildError } : {}), ...(rejected.length > 0 ? { rejected } : {}) }))
  }

  /** `POST /api/eval.submit` (SSE): scan / rubric×N / result / sm2 / done frames. */
  async function handleEvalSubmit(response: import('node:http').ServerResponse, body: string): Promise<void> {
    let input: { courseId?: unknown; taskId?: unknown; answer?: unknown; sessionId?: unknown; evalId?: unknown }
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
    // UI-7：评测幂等键——同一作答的重试直接重放已结算帧，不重复计分。
    const evalId = typeof input.evalId === 'string' && input.evalId !== '' ? input.evalId : null
    if (courseId === '' || taskId === '' || answer === '') {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'courseId/taskId/answer are required', details: null } }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const writeFrame = (event: string, data: unknown): void => {
      if (response.writableEnded || response.destroyed) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      for await (const frame of services.courseService.evalSubmit(courseId, taskId, answer, sessionId, evalId)) {
        const event = String(frame['event'] ?? '')
        writeFrame(event, frame['data'])
      }
    } catch (error) {
      writeFrame('error', { code: 'EVAL_FAILED', message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) })
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
      if (sessionId === null) { writeFrame('error', { code: 'invalid-request', message: 'queued turn requires sessionId' }); writeFrame('done', { usage: {}, turnId: queuedTurnId }); response.end(); return }
      // H-1：帧映射统一走 chat-service 的 agentEventToFrame——此前这里内联的
      // if 链缺 turn/cancelled → TURN_CANCELLED，取消的队列回合会被下方 done
      // 帧错误闭环为成功（半截回复当成功渲染）。
      for await (const event of agentService.queuedEvents(`study-${sessionId}`, queuedTurnId, abortController.signal)) {
        const frame = agentEventToFrame(event)
        if (frame === null) continue
        const mapped = frameToSseData(frame)
        writeFrame(mapped.event, mapped.data)
      }
      const usage = await agentService.projection(`study-${sessionId}`).then(projection => projection.usage).catch(() => ({}))
      writeFrame('done', { usage, turnId: queuedTurnId }); response.end(); return
    }
    // 生成器内部（如 courseDirOf 的课程校验）可能抛业务异常；SSE 头此时已
    // 发出，异常绝不能穿透到 RPC 兜底（headersSent 后再 writeHead 会以
    // ERR_HTTP_HEADERS_SENT 打崩整个进程）——就地转 error 帧收尾。
    try {
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
        // H-1：主路径与队列/重放路径共用 frameToSseData（chatStream 事件的
        // kind 集合与 agentEventToFrame 的返回同构）。meta 帧仍需就地解析
        // sessionId 供 done 帧收尾取 usage。
        if (event.kind === 'meta') {
          resolvedSessionId = String(event.payload['sessionId'] ?? resolvedSessionId ?? '') || null
        }
        const mapped = frameToSseData(event)
        writeFrame(mapped.event, mapped.data)
      }
    } catch (error) {
      if (abortController.signal.aborted) { response.end(); return }
      // BUG-005：SSE 错误帧同样可能携带上游凭据回显，出日志与帧前净化。
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
      console.error(`[studyclaw] chat/stream 失败:`, message)
      writeFrame('error', {
        code: 'CHAT_STREAM_FAILED',
        message,
      })
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
    let input: { agentId?: unknown; answer?: unknown; requestId?: unknown }
    try { input = JSON.parse(body === '' ? '{}' : body) as typeof input } catch {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'request body is not valid JSON', details: null } }))
      return
    }
    const agentId = typeof input.agentId === 'string' ? input.agentId : ''
    const answer = typeof input.answer === 'string' ? input.answer : ''
    // UI-14：answer 通道幂等键——中断重试时 attach 已落盘 turn 重放。
    const requestId = typeof input.requestId === 'string' && input.requestId !== '' ? input.requestId : null
    if (agentId === '' || answer.trim() === '') {
      response.writeHead(400)
      response.end(JSON.stringify({ error: { code: 'invalid-request', message: 'agentId and answer are required', details: null } }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const writeFrame = (event: string, data: unknown): void => {
      if (response.writableEnded || response.destroyed) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    let answeredTurnId: string | null = null
    try {
      const { handle } = await agentService.resolveAnswerTurn(agentId, answer, requestId)
      answeredTurnId = handle.turnId
      for await (const event of handle.events) {
        if (abortController.signal.aborted) break
        // H-1：此前内联的映射缺 turn/cancelled → TURN_CANCELLED——ask 幂等
        // 重放 attach 到已取消回合时半截回复会被 done 帧闭环为成功。统一走
        // agentEventToFrame 与主路径/队列路径同一语义。
        const frame = agentEventToFrame(event)
        if (frame === null) continue
        const mapped = frameToSseData(frame)
        writeFrame(mapped.event, mapped.data)
      }
    } catch (error) {
      writeFrame('error', { code: 'AGENT_ANSWER_FAILED', message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) })
    } finally {
      if (abortController.signal.aborted) {
        // 与 answerEvents 语义一致：客户端断连取消本回合（保留 inbox），
        // 防止待审批/挂起 turn 带定时器滞留。
        void agentService.cancel(agentId, true).catch(() => undefined)
      }
    }
    writeFrame('done', { usage: {}, turnId: answeredTurnId })
    response.end()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // FL-41：端口被占时的默认 EADDRINUSE 栈对用户不可读——给出行动指引。
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port === 0 ? '(随机)' : port} 已被占用（可能是另一个 StudyClaw 实例或其他应用）。可用 --port <n> 换端口，或排查占用进程后重试。`))
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      // FL-35：`--port 0` → 由内核分配随机端口；实际端口以 listen 结果为准，
      // 连同 token 写入 host.json 供 CLI/桌面端握手发现。
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      void writeHostConfig(actualPort, token).then(() => {
        console.log(`[studyclaw] host listening on http://127.0.0.1:${actualPort} (home: ${hostHome()}, logs: ${hostLogger.logDir}${token === null ? ', auth: DISABLED' : ''})`)
        if (options.open === true) void openBrowser(`http://127.0.0.1:${actualPort}`)
        resolve()
      }).catch(reject)
    })
  })

  const shutdown = async (): Promise<void> => {
    // server.close() 只在全部连接结束后回调；SSE（chat/agents/acp 流）是
    // 长连接、没有空闲关闭语义，不主动断开存量连接会让 Ctrl-C 永久挂起。
    // 先停止接新连接，再强制断开存量连接，5s 兜底超时保证清理序列必达。
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    const timeout = new Promise<void>(resolve => { const t = setTimeout(resolve, 5_000); t.unref?.() })
    await Promise.race([closed, timeout])
    removeHostConfig()
    instanceLock.release()
    hostLogger.stop()
    await ctx.fiber.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/** FL-21：`--open` 自动打开系统浏览器（不阻塞、失败静默）。 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (error) {
    console.warn(`[studyclaw] 打开浏览器失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** FL-21：Web UI 静态产物根目录。env 覆盖 > 仓库布局推断（对源码运行与
 * 打包产物同深度成立：apps/cli/src 与 apps/cli/lib 都距仓库根三级）。 */
function webDistRoot(): string {
  if (process.env.STUDYCLAW_WEB_DIST !== undefined && process.env.STUDYCLAW_WEB_DIST !== '') {
    return process.env.STUDYCLAW_WEB_DIST
  }
  return join(fileURLToPath(new URL('../../..', import.meta.url)), 'apps', 'web', 'out')
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
  // L11：事件历史在 <工作区根>/.studyclaw/history（v2 布局），旧代码漏掉
  // .studyclaw 段导致迁移命令永远扫空目录。
  const historyDir = join(stateDirOf(root), 'history')
  for (const course of courses) {
    const sessions = await listSessions(root, course.id)
    for (const session of sessions) {
      if (sessionId !== undefined && session.sessionId !== sessionId) continue
      const result = await migrateLegacySession(historyDir, session.sessionId)
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
    // FL-30/35/21：serve 旗标——token 逃生口、随机端口（--port 0）、自动开浏览器。
    await serve(Number.isFinite(port) ? port : 8080, {
      insecureNoToken: args.includes('--insecure-no-token'),
      open: args.includes('--open'),
    })
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
  } else if (command === 'sync') {
    // FL-13/FL-14：CLI 此前没有任何可触发课程构建的命令，quiz 空池提示指向
    // 不存在的 sync 命令（死链）。补注册 sync 分支，提示链真实可行。
    await syncCommand(args.slice(1))
  } else if (command === 'review') {
    await reviewCommand(args.slice(1))
  } else if (command === 'chat') {
    await chatCommand(args.slice(1))
  } else if (command === 'course') {
    // HANDOFF 待办 #2：顶层 course 命令接线（list/show，quiz/review 复用的
    // resolveCourse 同源）。
    await courseCommand(args.slice(1))
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
