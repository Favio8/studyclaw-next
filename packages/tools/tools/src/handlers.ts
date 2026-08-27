/**
 * Tool handlers for filesystem, interactive, and host-injected learning
 * actions. Ported from Python `agent_tools.py` handlers.
 * @module @studyclaw/tools/src/handlers
 */

import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { courseSourceRoot, isInplaceCourse, INPLACE_SOURCE_EXCLUDED_DIRS, resolveSourceRef, resolveStateFile } from './paths.ts'
import { ToolRejected } from './result.ts'
import { MAX_FILE_BYTES, MAX_NOTE_CHARS, MAX_READ_LINES, MAX_TOOL_MESSAGE_CHARS } from './specs.ts'

/** Per-course in-process lock (write_note read-modify-write serialization). */
const courseLocks = new Map<string, Promise<void>>()

function courseLock(courseDir: string): Promise<void> {
  const key = courseDir
  const previous = courseLocks.get(key) ?? Promise.resolve()
  const next = previous.then(() => undefined, () => undefined)
  courseLocks.set(key, next)
  return previous
}

/** The tuple returned by every host-side learning action. */
export type ToolHandlerResult = [string, Record<string, unknown>]

/** Minimal context exposed to host-side action adapters. */
export interface ToolActionContext {
  readonly courseDir: string
  readonly workspaceRoot: string
  /** Session provenance for learning actions that emit durable audit rows. */
  readonly sessionId?: string
}

/** Optional deployment capabilities supplied by the Host environment. */
export interface ToolProviders {
  readonly subprocess?: (input: { command: string; cwd: string; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  readonly fetch?: (input: { url: string; signal?: AbortSignal }) => Promise<{ status: number; contentType: string; body: string }>
  readonly webSearch?: (input: { query: string; signal?: AbortSignal }) => Promise<Array<{ title: string; url: string; snippet: string }>>
  /** Host/ACP subagent scheduler. The tools package never creates a loop. */
  readonly subagent?: (input: { task: string; cwd: string; signal?: AbortSignal }) => Promise<{ agentId?: string; status: string; summary: string }>
  /** Optional deployment capabilities exposed to future sandbox/LSP presets. */
  readonly sandbox?: (input: { command: string; cwd: string; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  readonly lsp?: (input: { method: string; params: Record<string, unknown>; cwd: string; signal?: AbortSignal }) => Promise<Record<string, unknown>>
}

/**
 * Host actions injected into the tools package. Keeping this interface here
 * avoids a dependency from the low-level tool registry back into chat-service.
 */
export interface ToolActions {
  readonly getTaskPool: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly createCard: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly generateDynamicCard: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly runReview: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly runQuiz: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly evaluateAnswer: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
  readonly syncSources: (ctx: ToolActionContext, args: Record<string, unknown>) => Promise<ToolHandlerResult>
}

/** One tool execution's context: course state + optional host actions. */
export interface ToolContext extends ToolActionContext {
  /** Cancellation for the current Agent turn. Providers and handlers should honor it. */
  readonly signal?: AbortSignal
  readonly actions?: ToolActions
  /** Optional DSH-style approval gate. `allow` executes; `deny` returns rejected. */
  readonly approval?: (request: { name: string; policy: string; args: Record<string, unknown> }) => Promise<'allow' | 'deny'>
  /** Optional deployment providers. Missing providers deliberately degrade. */
  readonly providers?: ToolProviders
}

function workspacePath(ctx: ToolContext, value: string): string {
  const root = resolve(ctx.workspaceRoot)
  const target = resolve(root, value)
  const relPath = relative(root, target)
  if (relPath === '' || relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\')) throw new ToolRejected('路径必须位于工作区内')
  return target
}

function isWithin(root: string, target: string): boolean {
  const relPath = relative(root, target)
  return relPath !== '' && relPath !== '..' && !relPath.startsWith('../') && !relPath.startsWith('..\\')
}

/** Resolve symlinks for generic filesystem tools before reading or writing. */
async function safeExistingPath(ctx: ToolContext, target: string): Promise<void> {
  const root = await realpath(ctx.workspaceRoot)
  const resolved = await realpath(target)
  if (!isWithin(root, resolved)) throw new ToolRejected('路径不能通过符号链接越界')
}

async function safeWriteParent(ctx: ToolContext, target: string): Promise<string> {
  const root = await realpath(ctx.workspaceRoot)
  let parent = dirname(target)
  while (true) {
    const info = await stat(parent).catch(() => null)
    if (info !== null) {
      const resolved = await realpath(parent)
      if (!isWithin(root, resolved) && resolved !== root) throw new ToolRejected('路径不能通过符号链接越界')
      return parent
    }
    const next = dirname(parent)
    if (next === parent) throw new ToolRejected('工作区父目录不存在')
    parent = next
  }
}

/** Generic DSH-style read_file tool. */
export async function handlerReadFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const path = workspacePath(ctx, String(args['path']))
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) throw new ToolRejected('文件不存在')
  await safeExistingPath(ctx, path)
  if (info.size > Number(args['maxBytes'] ?? MAX_FILE_BYTES)) throw new ToolRejected('文件超过读取上限')
  const content = await readFile(path, 'utf8')
  return [`已读取 ${relative(ctx.workspaceRoot, path).replaceAll('\\', '/')}`, { path: relative(ctx.workspaceRoot, path).replaceAll('\\', '/'), content }]
}

/** Generic DSH-style search_files tool. */
export async function handlerSearchFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const query = String(args['query']).trim()
  const root = workspacePath(ctx, String(args['path'] ?? '.'))
  const maxResults = Number(args['maxResults'] ?? 50)
  const matches: Array<{ path: string; line: number; text: string }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && /\.(md|txt|json|ts|tsx|js|jsx|yaml|yml)$/i.test(entry.name)) {
        const text = await readFile(path, 'utf8').catch(() => '')
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!line.toLowerCase().includes(query.toLowerCase())) continue
          matches.push({ path: relative(ctx.workspaceRoot, path).replaceAll('\\', '/'), line: index + 1, text: line.trim() })
          if (matches.length >= maxResults) return
        }
      }
      if (matches.length >= maxResults) return
    }
  }
  await walk(root)
  return [`找到 ${matches.length} 处匹配`, { matches, truncated: matches.length >= maxResults }]
}

/** Generic DSH-style write_file tool; the registry approval gate runs first. */
export async function handlerWriteFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const path = workspacePath(ctx, String(args['path']))
  await safeWriteParent(ctx, path)
  await mkdir(join(path, '..'), { recursive: true })
  await safeWriteParent(ctx, path)
  const existing = await stat(path).catch(() => null)
  if (existing !== null) await safeExistingPath(ctx, path)
  await writeFile(path, String(args['content']), 'utf8')
  return [`已写入 ${relative(ctx.workspaceRoot, path).replaceAll('\\', '/')}`, { path: relative(ctx.workspaceRoot, path).replaceAll('\\', '/'), bytes: Buffer.byteLength(String(args['content']), 'utf8') }]
}

export async function handlerRunCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const command = String(args['command'] ?? '').trim()
  if (command === '') throw new ToolRejected('command 不能为空')
  // Prefer an isolated sandbox (E2B/remote runner) when the host supplies
  // one; the local subprocess provider remains an explicit compatibility
  // fallback and is still approval-gated by ToolRegistry.
  const provider = ctx.providers?.sandbox ?? ctx.providers?.subprocess
  if (provider === undefined) throw new Error('subprocess/sandbox provider 未安装或未启用')
  const result = await provider({ command, cwd: ctx.workspaceRoot, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
  return [result.exitCode === 0 ? '命令执行完成' : `命令退出码 ${result.exitCode}`, {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, MAX_TOOL_MESSAGE_CHARS),
    stderr: result.stderr.slice(0, MAX_TOOL_MESSAGE_CHARS),
  }]
}

export async function handlerFetchUrl(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const url = String(args['url'] ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new ToolRejected('url 仅允许 http/https')
  if (ctx.providers?.fetch === undefined) throw new Error('web fetch provider 未安装或未启用')
  const result = await ctx.providers.fetch({ url, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
  return [`已获取 ${result.status}`, { url, status: result.status, contentType: result.contentType, body: result.body.slice(0, MAX_TOOL_MESSAGE_CHARS * 2) }]
}

export async function handlerSearchWeb(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const query = String(args['query'] ?? '').trim()
  if (query === '') throw new ToolRejected('query 不能为空')
  if (ctx.providers?.webSearch === undefined) throw new Error('web search provider 未安装或未启用')
  const results = await ctx.providers.webSearch({ query, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
  return [`找到 ${results.length} 条结果`, { results: results.slice(0, 10) }]
}

export async function handlerPlan(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const steps = Array.isArray(args['steps']) ? args['steps'].filter((item): item is string | Record<string, unknown> => typeof item === 'string' || (typeof item === 'object' && item !== null)).slice(0, 50) : []
  if (steps.length === 0) throw new ToolRejected('steps 不能为空')
  const projected = steps.map((step, index) => {
    if (typeof step === 'string') return step
    return {
      id: typeof step['id'] === 'string' ? step['id'] : `step-${index + 1}`,
      text: String(step['text'] ?? step['title'] ?? ''),
      status: step['status'] === 'completed' || step['status'] === 'in_progress' ? step['status'] : 'pending',
    }
  }).filter(step => typeof step === 'string' || step.text !== '')
  if (projected.length === 0) throw new ToolRejected('steps 不能为空')
  return ['计划已更新', { scope: relative(ctx.workspaceRoot, ctx.courseDir).replaceAll('\\', '/'), steps: projected }]
}

export async function handlerTodo(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const items = Array.isArray(args['items']) ? args['items'].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).slice(0, 100) : []
  if (items.length === 0) throw new ToolRejected('items 不能为空')
  return ['待办已更新', { items }]
}

export async function handlerSpawnAgent(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  if (ctx.providers?.subagent === undefined) throw new Error('subagent provider 未安装或未启用')
  const task = String(args['task'] ?? '').trim()
  const result = await ctx.providers.subagent({ task, cwd: ctx.workspaceRoot, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
  return [result.summary, { ...(result.agentId === undefined ? {} : { agentId: result.agentId }), status: result.status }]
}

const LSP_OPERATIONS = new Set(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])

/** DSH-compatible language-server navigation tool. Providers own transport
 * and protocol lifecycle; the model-facing contract stays semantic and
 * fail-closed when no LSP is installed. */
export async function handlerLsp(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const operation = String(args['operation'] ?? '')
  const filePath = String(args['file_path'] ?? '').trim()
  const line = Number(args['line'])
  const character = Number(args['character'])
  if (!LSP_OPERATIONS.has(operation)) throw new ToolRejected(`operation 必须是 ${[...LSP_OPERATIONS].join(', ')}`)
  if (filePath === '') throw new ToolRejected('file_path 不能为空')
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
    throw new ToolRejected('line 和 character 必须是从 1 开始的整数')
  }
  if (ctx.providers?.lsp === undefined) throw new Error('LSP provider 未安装或未启用')
  const result = await ctx.providers.lsp({
    method: operation,
    params: { filePath, position: { line: line - 1, character: character - 1 } },
    cwd: ctx.workspaceRoot,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })
  const projected = projectLspResult(result)
  return [`LSP ${operation} · ${filePath}:${line}:${character}`, projected]
}

function projectLspResult(result: Record<string, unknown>): Record<string, unknown> {
  const kind = result['kind']
  if (kind === 'locations' && Array.isArray(result['locations'])) {
    const locations = result['locations'].slice(0, 100).map((item) => {
      const value = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
      const range = typeof value['range'] === 'object' && value['range'] !== null ? value['range'] as Record<string, unknown> : {}
      return { uri: String(value['uri'] ?? ''), range }
    })
    return { kind: 'locations', locations, resolvedWorkspaceUri: typeof result['resolvedWorkspaceUri'] === 'string' ? result['resolvedWorkspaceUri'] : '' }
  }
  if (kind === 'hover') {
    const hover = result['hover']
    if (hover === null || hover === undefined) return { kind: 'hover', hover: null }
    const value = typeof hover === 'object' ? hover as Record<string, unknown> : {}
    return { kind: 'hover', hover: { contents: String(value['contents'] ?? '').slice(0, 16_000), ...(value['range'] === undefined ? {} : { range: value['range'] }) } }
  }
  return { kind: 'unknown', result: JSON.stringify(result).slice(0, 16_000) }
}

function rel(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

function validRefId(value: unknown): boolean {
  const text = String(value ?? '')
  return text !== '' && /^[A-Za-z0-9_-]+$/.test(text)
}

function noteLineTs(): string {
  return new Date().toISOString()
}

/** `read_source`: line-range read of one source file (limits + UTF-8 guard). */
export async function handlerReadSource(ctx: ToolContext, args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const path = await resolveSourceRef(ctx.courseDir, String(args['path']))
  if (!(await stat(path).catch(() => null))?.isFile()) {
    throw new ToolRejected(`文件不存在: ${rel(await courseSourceRoot(ctx.courseDir), path)}`)
  }
  const suffix = path.toLowerCase().match(/\.[^.]*$/)?.[0]
  if (suffix !== '.md' && suffix !== '.txt') {
    throw new ToolRejected(`暂不支持读取该文件类型: ${rel(await courseSourceRoot(ctx.courseDir), path)}`)
  }
  const size = (await stat(path)).size
  if (size > MAX_FILE_BYTES) throw new ToolRejected(`文件过大（>${MAX_FILE_BYTES / 1024}KB），请用 search_sources 精确定位`)
  const rootForRead = await courseSourceRoot(ctx.courseDir)
  const text = await readFile(path, 'utf8').catch(() => { throw new ToolRejected(`课程文件不是 UTF-8 文本: ${rel(rootForRead, path)}`) })
  const lines = text.split(/\r?\n/)
  const total = lines.length
  const start = Math.max(1, Number(args['startLine'] ?? 1))
  let end = Number(args['endLine'] ?? total)
  const maxLines = Number(args['maxLines'] ?? MAX_READ_LINES)
  end = Math.min(total, Math.max(start, end))
  const kept = lines.slice(start - 1, end)
  const truncated = kept.length > maxLines
  const shown = kept.slice(0, maxLines)
  const root = await courseSourceRoot(ctx.courseDir)
  const relPath = rel(root, path)
  const last = shown.length > 0 ? start + shown.length - 1 : start - 1
  const data = {
    path: relPath,
    totalLines: total,
    startLine: start,
    endLine: last,
    truncated,
    lines: shown.map((line, index) => ({ n: start + index, text: line })),
  }
  return [`已读取 ${relPath} ${start}-${last} 行（共 ${total} 行）${truncated ? '（已截断）' : ''}`, data]
}

async function* iterSourceFiles(root: string): AsyncGenerator<string> {
  const excluded = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) stack.push(join(current, entry.name))
        continue
      }
      if (entry.isFile()) yield join(current, entry.name)
    }
  }
}

/** `search_sources`: case-insensitive grep over the source tree. */
export async function handlerSearchSources(ctx: ToolContext, args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const query = String(args['query'] ?? '').trim()
  if (query === '') throw new ToolRejected('query 不能为空')
  const maxResults = Number(args['maxResults'] ?? 20)
  const caseSensitive = Boolean(args['caseSensitive'])
  const needle = caseSensitive ? query : query.toLowerCase()
  const root = await courseSourceRoot(ctx.courseDir)
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    return ['0 处匹配', { matches: [], filesScanned: 0, totalMatches: 0 }]
  }
  const inplace = await isInplaceCourse(ctx.courseDir)
  const matches: Array<{ file: string; line: number; text: string }> = []
  let filesScanned = 0
  let skippedOversize = 0
  // 二进制/富文档无法按行 utf8 grep，静默读会产生乱码匹配；显式跳过并上报。
  const BINARY_SOURCE_RE = /\.(pdf|docx?|pptx?|xlsx?|rtf|odt)$/i
  for await (const path of iterSourceFiles(root)) {
    const parts = relative(root, path).split(/[\\/]/)
    if (inplace && parts.some(part => INPLACE_SOURCE_EXCLUDED_DIRS.has(part))) continue
    if ((await stat(path)).size > MAX_FILE_BYTES) { skippedOversize += 1; continue }
    if (BINARY_SOURCE_RE.test(path)) { skippedOversize += 1; continue }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    filesScanned += 1
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const hay = caseSensitive ? line : line.toLowerCase()
      if (hay.includes(needle)) {
        matches.push({ file: rel(root, path), line: i + 1, text: line.trim() })
        if (matches.length >= maxResults) break
      }
    }
  }
  const truncated = matches.length >= maxResults
  const total = matches.length
  const skippedNote = skippedOversize > 0 ? `；另有 ${skippedOversize} 个 PDF/超大文件未纳入检索` : ''
  return [`关键词 ${query}：${total} 处匹配（扫描 ${filesScanned} 个文件${skippedNote}）`, { matches, filesScanned, totalMatches: total, truncated, skippedOversize }]
}

/** progress.md concept rows: `| id | name | chapter | mastery | ... |`. */
function parseProgressTable(text: string): Array<{ conceptId: string; name: string; chapter: string; mastery: number; evals: number; nextReviewAt: string | null }> {
  const rows: Array<{ conceptId: string; name: string; chapter: string; mastery: number; evals: number; nextReviewAt: string | null }> = []
  const lines = text.split(/\r?\n/)
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.includes('concept_id')) { inTable = true; continue }
    if (!inTable) continue
    if (!trimmed.startsWith('|')) break
    const cells = trimmed.split('|').map(cell => cell.trim())
    // split('|') keeps a leading empty cell: [ '', id, name, chapter, mastery, evals, ... ]
    if (cells.length < 6) continue
    const separator = cells.slice(1).join('').replace(/[-\s:]/g, '')
    if (separator === '') continue
    const masteryRaw = cells[4] ?? '0'
    const mastery = masteryRaw.endsWith('%')
      ? Math.min(1, Number(masteryRaw.slice(0, -1)) / 100)
      : Number(masteryRaw)
    rows.push({
      conceptId: cells[1]!,
      name: cells[2]!,
      chapter: cells[3]!,
      mastery: Number.isFinite(mastery) ? Math.max(0, Math.min(1, mastery)) : 0,
      evals: Number(cells[5] ?? 0) || 0,
      nextReviewAt: cells.length > 9 ? cells[9]! : null,
    })
  }
  return rows
}

/** `get_course_state`: syllabus + mastery board + due/weak summary. */
export async function handlerGetCourseState(ctx: ToolContext, _args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const syllabusPath = await resolveStateFile(ctx.courseDir, 'syllabus.json')
  let title = ctx.courseDir.split(/[\\/]/).pop() ?? ctx.courseDir
  let version = ''
  const chapters: Array<{ id: string; title: string; concepts: Array<{ id: string; name: string }> }> = []
  const syllabus = await readFile(syllabusPath, 'utf8').catch(() => null)
  if (syllabus !== null) {
    try {
      const parsed = JSON.parse(syllabus) as { title?: string; version?: string; chapters?: Array<{ id: string; title: string; concepts?: Array<{ id: string; name: string }> }> }
      title = parsed.title ?? title
      version = parsed.version ?? ''
      for (const chapter of parsed.chapters ?? []) {
        chapters.push({ id: chapter.id, title: chapter.title, concepts: (chapter.concepts ?? []).map(c => ({ id: c.id, name: c.name })) })
      }
    } catch {
      // Corrupt syllabus: title falls back to the directory name.
    }
  }
  const progressText = await readFile(await resolveStateFile(ctx.courseDir, 'progress.md'), 'utf8').catch(() => '')
  const concepts = parseProgressTable(progressText)
  const mastery = Object.fromEntries(concepts.map(c => [c.conceptId, c.mastery]))
  const today = new Date().toISOString().slice(0, 10)
  const dueIds = concepts
    .filter(c => c.nextReviewAt !== null && c.nextReviewAt.slice(0, 10) <= today)
    .map(c => c.conceptId)
  const weak = concepts.filter(c => c.mastery < 0.4).map(c => c.conceptId)
  const data = {
    courseId: ctx.courseDir.split(/[\\/]/).pop() ?? '',
    title,
    version,
    chapters,
    mastery,
    dueIds,
    weakIds: weak,
    dueCount: dueIds.length,
    weakCount: weak.length,
    lastUpdatedAt: null,
  }
  return [
    `${title}：${chapters.length} 章 ${concepts.length} 概念 · 到期 ${dueIds.length} · 薄弱 ${weak.length}`,
    data,
  ]
}

/** `get_memory`: global profile (Memory.md) + course pool note (M2 simplified). */
export async function handlerGetMemory(ctx: ToolContext, _args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const memoryPath = join(ctx.workspaceRoot, '.studyclaw', 'Memory.md')
  const memory = await readFile(memoryPath, 'utf8').catch(() => null)
  if (memory === null || memory.trim() === '') {
    return ['（尚无沉淀）', { global: '', course: [] }]
  }
  return [memory.trim().slice(0, 2000), { global: memory.trim(), course: [] }]
}

async function runInjectedAction(
  ctx: ToolContext,
  name: keyof ToolActions,
  args: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  const action = ctx.actions?.[name]
  if (action === undefined) throw new Error(`工具动作未注入: ${String(name)}`)
  return action({ courseDir: ctx.courseDir, workspaceRoot: ctx.workspaceRoot, ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }) }, args)
}

/** Learning actions are delegated to the host service through ToolActions. */
export function handlerGetTaskPool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'getTaskPool', args)
}

export function handlerCreateCard(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'createCard', args)
}

export function handlerGenerateDynamicCard(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'generateDynamicCard', args)
}

export function handlerRunReview(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'runReview', args)
}

export function handlerRunQuiz(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'runQuiz', args)
}

export function handlerEvaluateAnswer(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'evaluateAnswer', args)
}

export function handlerSyncSources(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  return runInjectedAction(ctx, 'syncSources', args)
}

/** `write_note`: append one line to notes.md (append-only, per-course lock). */
export async function handlerWriteNote(ctx: ToolContext, args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const content = String(args['content'] ?? '').trim()
  if (content === '') throw new ToolRejected('content 不能为空')
  if (content.length > MAX_NOTE_CHARS) throw new ToolRejected(`笔记过长（>${MAX_NOTE_CHARS} 字符），请精简后再记录`)
  const normalized = content.split(/\s+/).join(' ')
  const conceptId = args['conceptId']
  if (conceptId !== undefined && !validRefId(conceptId)) throw new ToolRejected('conceptId 只能包含字母/数字/下划线/连字符（禁止换行注入）')
  const chapterId = args['chapterId']
  if (chapterId !== undefined && !validRefId(chapterId)) throw new ToolRejected('chapterId 只能包含字母/数字/下划线/连字符（禁止换行注入）')
  const prefix = conceptId === undefined ? '' : `[${conceptId}] `
  const line = `- ${noteLineTs()} ${prefix}${normalized}\n`
  const path = join(ctx.courseDir, 'notes.md')
  await courseLock(ctx.courseDir)
  try {
    let old = ''
    const existing = await stat(path).catch(() => null)
    if (existing !== null) {
      if (existing.isSymbolicLink()) throw new Error('学生笔记路径不允许是符号链接（防越界读取/污染）')
      if (!existing.isFile()) throw new Error(`学生笔记路径被占用（非文件）: notes.md`)
      old = await readFile(path, 'utf8')
      if (old !== '' && !old.endsWith('\n')) old += '\n'
    }
    await writeFile(path, old + line, 'utf8')
  } finally {
    courseLocks.delete(ctx.courseDir)
  }
  return ['已记录', { file: 'notes.md', appended: normalized.length, lines: 1 }]
}

/** `ask_user_question`: M-C interactive tool — the chat loop ends the turn. */
export async function handlerAskUserQuestion(_ctx: ToolContext, args: Record<string, unknown>): Promise<[string, Record<string, unknown>]> {
  const question = String(args['question'] ?? '').trim()
  if (question === '') throw new ToolRejected('question 不能为空')
  if (question.length > MAX_NOTE_CHARS) throw new ToolRejected(`提问过长（>${MAX_NOTE_CHARS} 字符）`)
  return ['已向学生提问', { ask: true, question }]
}
