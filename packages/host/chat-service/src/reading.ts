/**
 * Reading service（PRD 需求三）：资料精读的标注存储与 LLM 动作。
 *
 * 数据契约（文件即状态）：`<课程>/.studyclaw/annotations.json`，单课程单文件，
 * 人类可读。定位用双锚——几何 rects 归一化到 0-1（相对页面宽高），文本 quote
 * （Hypothesis 式 text/prefix/suffix）供版面轻微变化时重定位。
 *
 * 并发：课程锁保护"读 → 改 → 写"和读取时触发的恢复，跨标签页/进程不丢更新。
 * 损坏：JSON 语法/结构失败 → 唯一备份 `.bak-*` → 空结构重建，返回 recovered；
 * 读取或备份失败则报告错误并保留原文件（storage-domain 的 quarantine 是
 * 记录级机制，不适用于裸 JSON 文件）。
 * @module @studyclaw/chat-service/src/reading
 */
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { appendCourseNotes, resolveSourceRef, withCourseLock } from '@studyclaw/tools'
import { readSourceDocument, type SourceBlock, documentKind, extractTextToMarkdownWithEngine, parsedFileName, writeParsedText, saveParsedManifest, loadParsedManifest, loadProgressBoard, readParsedText, recordExposure, saveProgressBoard, type ParsedEngine } from '@studyclaw/course-builder'
import { loadCourseState } from '@studyclaw/session'
import type { ResolvedChatConfig } from './config.ts'
import { createDeepSeekToolClient } from './adapter.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { renameWithRetry } from '@studyclaw/fs-atomic'

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'red'

export interface AnnotationRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface AnnotationRecord {
  readonly id: string
  readonly page: number
  readonly rects: AnnotationRect[]
  readonly quote: { readonly text: string; readonly prefix: string; readonly suffix: string }
  readonly color: AnnotationColor
  readonly comment: string
  readonly tags: string[]
  readonly conceptId: string | null
  readonly createdAt: string
}

export interface ReadingProgress {
  readonly page: number
  readonly percent: number
  readonly updatedAt: string
}

interface SourceAnnotations {
  progress: ReadingProgress
  highlights: AnnotationRecord[]
}

interface AnnotationsFile {
  version: 1
  sources: Record<string, SourceAnnotations>
}

export type ReadingViewKind = 'pdf' | 'image' | 'markdown' | 'unsupported'

/**
 * M2：复习时的「回顾原文」线索。取自该概念的标注划线，**只进 UI，绝不进评测
 * 提示词**——否则用户可以照抄原文，评测失真。
 */
export interface ReviewHint {
  readonly text: string
  readonly prefix: string
  readonly suffix: string
  readonly source: string
  readonly page: number
}

/** 每题最多回看几条划线；再多就不是"回忆线索"而是"照抄答案"。 */
export const MAX_REVIEW_HINTS = 2
const CONTEXT_MAX = 60

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * M2：取一批概念的复习线索，一次读盘、一次组包——不做 per-concept 读盘
 * （复习一批题往往同属少数概念，重复 I/O 没有收益）。
 *
 * 读取失败时降级为空 Map：复习流必须照常可用，标注只是锦上添花。
 */
export async function loadReviewHints(
  workspaceRoot: string,
  conceptIds: readonly string[],
): Promise<Map<string, ReviewHint[]>> {
  const wanted = new Set(conceptIds)
  if (wanted.size === 0) return new Map()
  const stateDir = join(workspaceRoot, '.studyclaw')
  const { file } = await withCourseLock(workspaceRoot, () => readAnnotations(stateDir)).catch(() => ({
    file: emptyFile() as AnnotationsFile,
  }))
  const collected = new Map<string, Array<{ readonly at: string; readonly hint: ReviewHint }>>()
  for (const [source, entry] of Object.entries(file.sources)) {
    for (const highlight of entry.highlights) {
      const conceptId = highlight.conceptId
      if (conceptId === null || !wanted.has(conceptId)) continue
      const bucket = collected.get(conceptId) ?? []
      bucket.push({
        at: highlight.createdAt,
        hint: {
          text: highlight.quote.text,
          prefix: clip(highlight.quote.prefix, CONTEXT_MAX),
          suffix: clip(highlight.quote.suffix, CONTEXT_MAX),
          source,
          page: highlight.page,
        },
      })
      collected.set(conceptId, bucket)
    }
  }
  // 最近的划线最贴近当前记忆；createdAt 同值时按原文兜底，保证顺序确定（测试可复现）。
  const result = new Map<string, ReviewHint[]>()
  for (const [conceptId, entries] of collected) {
    entries.sort((a, b) => b.at.localeCompare(a.at) || b.hint.text.localeCompare(a.hint.text))
    result.set(conceptId, entries.slice(0, MAX_REVIEW_HINTS).map(entry => entry.hint))
  }
  return result
}

/**
 * M4/M5：标注按概念聚合（总条数 + 最近一次时间），并**精确**统计近 24 小时
 * 新建的条数——只凭「最近时间在窗口内」会把该概念更早的划线一并算进来。
 *
 * 读取失败返回空结构：摘要类信息缺失不该让整个面板报错。
 *
 * `courseDir` 是**课程目录**（锁的键必须与本模块其余读写一致，都是课程目录）。
 * 曾误传 `stateDir` 作键，那会取到一把**与标注写入不互斥**的锁——摘要读盘可能
 * 撞上另一次恢复/重建，两边各持不同的锁却操作同一个文件。
 */
export async function readAnnotationsDigest(
  courseDir: string,
  sinceMs: number,
): Promise<{ byConcept: Map<string, { count: number; lastAt: string }>; recentCount: number }> {
  const stateDir = join(courseDir, '.studyclaw')
  const noData = { byConcept: new Map<string, { count: number; lastAt: string }>(), recentCount: 0 }
  const file = await withCourseLock(courseDir, () => readAnnotations(stateDir))
    .then(result => result.file)
    .catch(() => emptyFile() as AnnotationsFile)
  if (Object.keys(file.sources).length === 0) return noData
  const since = new Date(sinceMs).toISOString()
  const byConcept = new Map<string, { count: number; lastAt: string }>()
  let recentCount = 0
  for (const entry of Object.values(file.sources)) {
    for (const highlight of entry.highlights) {
      if (highlight.createdAt >= since) recentCount += 1
      if (highlight.conceptId === null) continue
      const current = byConcept.get(highlight.conceptId) ?? { count: 0, lastAt: '' }
      current.count += 1
      if (highlight.createdAt > current.lastAt) current.lastAt = highlight.createdAt
      byConcept.set(highlight.conceptId, current)
    }
  }
  return { byConcept, recentCount }
}

export interface ReadingLoadResult {
  readonly source: string
  readonly view: ReadingViewKind
  readonly exists: boolean
  readonly progress: ReadingProgress
  readonly highlights: AnnotationRecord[]
  /** 标注文件损坏并已重建时为 true（旧文件备份为 .bak-*）。 */
  readonly recovered: boolean
}

const EMPTY_PROGRESS: ReadingProgress = { page: 1, percent: 0, updatedAt: '' }

function annotationsPathOf(stateDir: string): string {
  return join(stateDir, 'annotations.json')
}

function viewKindOf(source: string): ReadingViewKind {
  const lower = source.toLowerCase()
  if (documentKind(source) === 'pdf' || documentKind(source) === 'office') return 'pdf'
  if (documentKind(source) === 'image') return 'image'
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'markdown'
  return 'unsupported'
}

function emptyFile(): AnnotationsFile {
  return { version: 1, sources: Object.create(null) as Record<string, SourceAnnotations> }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPage(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isUnit(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Validate the persisted contract before any reader/export code consumes it. */
function isAnnotationsFile(value: unknown): value is AnnotationsFile {
  if (!isObject(value) || value['version'] !== 1 || !isObject(value['sources'])) return false
  return Object.values(value['sources']).every(entry => {
    if (!isObject(entry) || !isObject(entry['progress']) || !Array.isArray(entry['highlights'])) return false
    const progress = entry['progress']
    if (!isPage(progress['page']) || typeof progress['percent'] !== 'number'
      || !Number.isFinite(progress['percent']) || progress['percent'] < 0 || progress['percent'] > 100
      || typeof progress['updatedAt'] !== 'string') return false
    return entry['highlights'].every(record => {
      if (!isObject(record) || typeof record['id'] !== 'string' || !isPage(record['page'])
        || !Array.isArray(record['rects']) || !isObject(record['quote'])) return false
      const quote = record['quote']
      return record['rects'].every(rect => isObject(rect) && ['x', 'y', 'w', 'h'].every(key => isUnit(rect[key])))
        && ['text', 'prefix', 'suffix'].every(key => typeof quote[key] === 'string')
        && typeof record['color'] === 'string' && ['yellow', 'green', 'blue', 'red'].includes(record['color'])
        && typeof record['comment'] === 'string' && Array.isArray(record['tags'])
        && record['tags'].every(tag => typeof tag === 'string')
        && (record['conceptId'] === null || typeof record['conceptId'] === 'string')
        && typeof record['createdAt'] === 'string'
    })
  })
}

/**
 * 资料路径解析：与 read_source/courses.files 同一约定（courses.files 的
 * relative 相对源根，源根可能是 .source-root.json 绑定的子目录）。越界、
 * 隐藏段、8.3 短名等由 resolveSourceRef 统一拒绝。
 */
async function resolveSource(workspaceRoot: string, source: string): Promise<string> {
  try {
    return await resolveSourceRef(workspaceRoot, source)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

/** 流式 sha256（大文件不整读进内存）；返回 `sha256:<hex>` 与 checksums 同格式。 */
async function sha256Of(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise())
  })
  return `sha256:${hash.digest('hex')}`
}

/** Caller holds the course lock: recovery also mutates the annotations file. */
async function readAnnotations(stateDir: string): Promise<{ file: AnnotationsFile; recovered: boolean }> {
  const path = annotationsPathOf(stateDir)
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return { file: emptyFile(), recovered: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // Syntax errors and invalid structures use the same recovery path below.
  }
  if (isAnnotationsFile(parsed)) return { file: parsed, recovered: false }
  // Do not overwrite damaged data if the backup fails. The unique name and
  // shared lock keep concurrent reads/writes from backing up a fresh update.
  await renameWithRetry(path, `${path}.bak-${Date.now().toString(36)}-${randomUUID()}`)
  const file = emptyFile()
  await writeAnnotations(stateDir, file)
  return { file, recovered: true }
}

async function writeAnnotations(stateDir: string, file: AnnotationsFile): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const path = annotationsPathOf(stateDir)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await renameWithRetry(tmp, path)
}

/**
 * M1：累加 `progress.md` 里的阅读接触次数。调用方已持有课程写锁，整个读板→
 * 改板→存板都在临界区内。
 *
 * 曝光是**非关键遥测**：失败只记日志，绝不抛出——用户的标注已经落盘，不该因为
 * 一个统计数字写不进去而看到报错或丢失划线。
 */
async function bumpExposure(stateDir: string, conceptId: string): Promise<void> {
  try {
    const boardPath = join(stateDir, 'progress.md')
    const board = await loadProgressBoard(boardPath)
    await saveProgressBoard(boardPath, recordExposure(board, conceptId, 1))
  } catch (error) {
    console.warn('[reading] 曝光计数写入失败，已忽略（标注已保存）', error)
  }
}

function sourceEntry(file: AnnotationsFile, source: string): SourceAnnotations {
  const existing = Object.hasOwn(file.sources, source) ? file.sources[source] : undefined
  if (existing !== undefined && Array.isArray(existing.highlights)) return existing
  const fresh: SourceAnnotations = { progress: { ...EMPTY_PROGRESS }, highlights: [] }
  Object.defineProperty(file.sources, source, { value: fresh, enumerable: true, configurable: true, writable: true })
  return fresh
}

function normalizeColor(value: unknown): AnnotationColor {
  return value === 'green' || value === 'blue' || value === 'red' ? value : 'yellow'
}

function normalizeRects(value: unknown): AnnotationRect[] {
  if (!Array.isArray(value)) return []
  const rects: AnnotationRect[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const rect = item as Record<string, unknown>
    const x = Number(rect['x']), y = Number(rect['y']), w = Number(rect['w']), h = Number(rect['h'])
    if (![x, y, w, h].every(Number.isFinite)) continue
    rects.push({ x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) })
  }
  return rects
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 阅读服务：标注 CRUD、进度、导出与 LLM 动作（explain/translate SSE 数据源）。 */
export class ReadingService {

  async load(workspaceRoot: string, source: string): Promise<ReadingLoadResult> {
    const stateDir = join(workspaceRoot, '.studyclaw')
    const { file, recovered } = await withCourseLock(workspaceRoot, () => readAnnotations(stateDir))
    const entry = sourceEntry(file, source)
    const target = await resolveSource(workspaceRoot, source).catch(() => null)
    // 存在性用 stat 判定，不要 readFile：后者会把整份资料读进内存只为丢弃
    // （实测 200MB 文件 110ms vs stat 0.115ms，且多占一份全文空间），
    // 而 reading.load 是每次打开资料都会跑的路径。目录同样判为不存在，
    // 与原先 readFile 在目录上抛 EISDIR 的结果一致。
    const exists = target !== null && (await stat(target).catch(() => null))?.isFile() === true
    return {
      source,
      view: viewKindOf(source),
      exists,
      progress: entry.progress,
      highlights: entry.highlights,
      recovered,
    }
  }

  async saveProgress(workspaceRoot: string, source: string, page: number, percent: number): Promise<ReadingProgress> {
    const stateDir = join(workspaceRoot, '.studyclaw')
    return withCourseLock(workspaceRoot, async () => {
      const { file } = await readAnnotations(stateDir)
      const entry = sourceEntry(file, source)
      const progress: ReadingProgress = {
        page: Math.max(1, Math.round(Number.isFinite(page) ? page : 1)),
        percent: Math.round(clamp01(Number.isFinite(percent) ? percent / 100 : 0) * 100),
        updatedAt: new Date().toISOString(),
      }
      entry.progress = progress
      await writeAnnotations(stateDir, file)
      return progress
    })
  }

  async listHighlights(workspaceRoot: string, source: string): Promise<AnnotationRecord[]> {
    const { file } = await withCourseLock(workspaceRoot, () => readAnnotations(join(workspaceRoot, '.studyclaw')))
    return sourceEntry(file, source).highlights
  }

  async addHighlight(workspaceRoot: string, source: string, input: Record<string, unknown>): Promise<AnnotationRecord> {
    const stateDir = join(workspaceRoot, '.studyclaw')
    return withCourseLock(workspaceRoot, async () => {
      const { file } = await readAnnotations(stateDir)
      const entry = sourceEntry(file, source)
      const record: AnnotationRecord = {
        id: `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        page: Math.max(1, Math.round(Number(input['page']) || 1)),
        rects: normalizeRects(input['rects']),
        quote: {
          text: String(input['quote'] ?? ''),
          prefix: String(input['prefix'] ?? ''),
          suffix: String(input['suffix'] ?? ''),
        },
        color: normalizeColor(input['color']),
        comment: String(input['comment'] ?? ''),
        tags: Array.isArray(input['tags']) ? input['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : [],
        conceptId: typeof input['conceptId'] === 'string' && input['conceptId'] !== '' ? input['conceptId'] : null,
        createdAt: new Date().toISOString(),
      }
      entry.highlights.push(record)
      await writeAnnotations(stateDir, file)
      // M1：划线即证据——关联了概念的标注顺带记一次"阅读接触"。
      // 失败绝不回滚已保存的标注：曝光是观测维度，不是主流程。
      if (record.conceptId !== null) await bumpExposure(stateDir, record.conceptId)
      return record
    })
  }

  async updateHighlight(workspaceRoot: string, source: string, id: string, patch: Record<string, unknown>): Promise<AnnotationRecord | null> {
    const stateDir = join(workspaceRoot, '.studyclaw')
    return withCourseLock(workspaceRoot, async () => {
      const { file } = await readAnnotations(stateDir)
      const entry = sourceEntry(file, source)
      const index = entry.highlights.findIndex(item => item.id === id)
      if (index < 0) return null
      const current = entry.highlights[index]!
      const next: AnnotationRecord = {
        ...current,
        color: patch['color'] === undefined ? current.color : normalizeColor(patch['color']),
        comment: patch['comment'] === undefined ? current.comment : String(patch['comment']),
        tags: patch['tags'] === undefined ? current.tags : (Array.isArray(patch['tags']) ? patch['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : current.tags),
        conceptId: patch['conceptId'] === undefined
          ? current.conceptId
          : (typeof patch['conceptId'] === 'string' && patch['conceptId'] !== '' ? patch['conceptId'] : null),
      }
      entry.highlights[index] = next
      await writeAnnotations(stateDir, file)
      return next
    })
  }

  async removeHighlight(workspaceRoot: string, source: string, id: string): Promise<boolean> {
    const stateDir = join(workspaceRoot, '.studyclaw')
    return withCourseLock(workspaceRoot, async () => {
      const { file } = await readAnnotations(stateDir)
      const entry = sourceEntry(file, source)
      const before = entry.highlights.length
      entry.highlights = entry.highlights.filter(item => item.id !== id)
      if (entry.highlights.length === before) return false
      await writeAnnotations(stateDir, file)
      return true
    })
  }

  /** 导出某资料的标注为 Markdown（按页分组）。用户主动动作，直接返回文本。 */
  /** md/txt 资料正文（MarkdownReader 用）。路径守卫与 read_source 同款。 */
  /**
   * 解析视图（PRD P2.5）：docx/xlsx/html 与扫描件 PDF 的 Markdown 产物。
   * 读 parsed/ 缓存（manifest 归因）；源文件变化或未构建时不可用并给出原因。
   */
  async parsed(workspaceRoot: string, source: string): Promise<{
    source: string
    available: boolean
    engine: ParsedEngine | null
    tier: string | null
    markdown: string
    reason: string | null
    blocks?: SourceBlock[]
  }> {
    const target = await resolveSource(workspaceRoot, source)
    const stateDir = join(workspaceRoot, '.studyclaw')
    const manifest = await loadParsedManifest(stateDir)
    const entry = manifest[source]
    if (entry === undefined || entry.out === null) {
      const document = await readSourceDocument(target, source, stateDir)
      const sha256 = await sha256Of(target)
      const outcome = documentKind(source) === 'image' || document.blocks.some(block => block.bbox != null) ? { text: document.blocks.map(block => block.text).join('\n\n'), engine: 'mineru' as const } : await extractTextToMarkdownWithEngine(target)
      const out = await writeParsedText(stateDir, parsedFileName(sha256, `${outcome.engine}-reading`), outcome.text)
      manifest[source] = { sha256, engine: outcome.engine, tier: 'reading', out }
      await withCourseLock(workspaceRoot, async () => {
        const current = await loadParsedManifest(stateDir)
        current[source] = manifest[source]!
        await saveParsedManifest(stateDir, current)
      })
      return { source, available: true, engine: outcome.engine, tier: 'reading', markdown: outcome.text, reason: null, blocks: document.blocks }
    }
    const sha = await sha256Of(target).catch(() => null)
    if (sha === null) {
      return { source, available: false, engine: null, tier: null, markdown: '', reason: '资料文件不存在或不可读' }
    }
    if (sha !== entry.sha256) {
      return {
        source, available: false, engine: entry.engine, tier: entry.tier, markdown: '',
        reason: '源文件已变化：重新构建课程后刷新即可阅读最新内容',
      }
    }
    const markdown = await readParsedText(stateDir, entry.out) ?? ''
    if (markdown.trim() === '') {
      return { source, available: false, engine: entry.engine, tier: entry.tier, markdown: '', reason: '解析产物缺失或为空：重新构建课程' }
    }
    const document = await readSourceDocument(target, source, stateDir)
    return { source, available: true, engine: entry.engine, tier: entry.tier, markdown, reason: null, blocks: document.blocks }
  }

  async readText(workspaceRoot: string, source: string): Promise<{ text: string; truncated: boolean }> {
    const target = await resolveSource(workspaceRoot, source)
    if (!/\.(md|txt)$/i.test(target)) {
      throw new Error('source 必须是课程资料根目录下的 .md/.txt 文件')
    }
    const MAX = 200_000
    // Four bytes per code point plus one lookahead bounds disk I/O and memory.
    // Reading the whole file before slicing defeats this endpoint's limit.
    const handle = await open(target, 'r').catch(() => null)
    if (handle === null) throw new Error('资料不存在或不可读')
    const bytes = Buffer.alloc(MAX * 4 + 4)
    let offset = 0
    try {
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
    } finally { await handle.close() }
    const raw = bytes.subarray(0, offset).toString('utf8')
    return { text: raw.length > MAX ? raw.slice(0, MAX) : raw, truncated: raw.length > MAX }
  }

  /**
   * P3「我的痕迹」：全课程标注按 conceptId 聚合（只读信号，不改掌握度）。
   * 无概念关联的标注不进聚合——避免把未归属的划线算成学习证据。
   */
  async traces(workspaceRoot: string): Promise<{ traces: Array<{ conceptId: string; count: number; lastAt: string }> }> {
    const { file } = await withCourseLock(workspaceRoot, () => readAnnotations(join(workspaceRoot, '.studyclaw')))
    const aggregated = new Map<string, { count: number; lastAt: string }>()
    for (const entry of Object.values(file.sources)) {
      for (const record of entry.highlights) {
        if (record.conceptId === null) continue
        const current = aggregated.get(record.conceptId) ?? { count: 0, lastAt: '' }
        current.count += 1
        if (record.createdAt > current.lastAt) current.lastAt = record.createdAt
        aggregated.set(record.conceptId, current)
      }
    }
    const traces = [...aggregated.entries()]
      .map(([conceptId, value]) => ({ conceptId, count: value.count, lastAt: value.lastAt }))
      .sort((a, b) => b.count - a.count || a.conceptId.localeCompare(b.conceptId))
    return { traces }
  }

  /**
   * P3 导出追加到课程笔记（notes.md）。用户主动动作，直接写不走审批；
   * 带 HTML 注释标记来源与时间，重复导出可追溯、可手工清理。
   */
  async appendNotes(workspaceRoot: string, source: string): Promise<{ appended: boolean; count: number }> {
    const { markdown, count } = await this.exportMarkdown(workspaceRoot, source)
    if (count === 0) return { appended: false, count: 0 }
    await appendCourseNotes(workspaceRoot, `\n<!-- reading-export ${new Date().toISOString()} source=${source} -->\n${markdown}\n`)
    return { appended: true, count }
  }

  /**
   * F3：把 AI 概括结果保存到课程笔记（notes.md）。用户主动动作，沿用追加笔记
   * 入口与课程锁；带资料名与生成时间标记，重复保存可追溯。
   */
  async appendSummary(workspaceRoot: string, source: string, markdown: string): Promise<{ appended: boolean }> {
    const content = markdown.trim()
    if (content === '') return { appended: false }
    await appendCourseNotes(workspaceRoot, `\n<!-- reading-summary ${new Date().toISOString()} source=${source} -->\n${content}\n`)
    return { appended: true }
  }

  async exportMarkdown(workspaceRoot: string, source: string): Promise<{ markdown: string; count: number }> {
    const { file } = await withCourseLock(workspaceRoot, () => readAnnotations(join(workspaceRoot, '.studyclaw')))
    const entry = sourceEntry(file, source)
    const byPage = new Map<number, AnnotationRecord[]>()
    for (const record of entry.highlights) {
      const list = byPage.get(record.page) ?? []
      list.push(record)
      byPage.set(record.page, list)
    }
    const lines: string[] = [`# 《${source}》阅读标注`, '']
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
      lines.push(`## 第 ${page} 页`, '')
      for (const record of byPage.get(page) ?? []) {
        lines.push(`> ${record.quote.text || '（区域标注）'}`)
        const meta: string[] = []
        if (record.comment !== '') meta.push(`批注：${record.comment}`)
        if (record.tags.length > 0) meta.push(`标签：${record.tags.join('、')}`)
        if (record.conceptId !== null) meta.push(`概念：${record.conceptId}`)
        if (meta.length > 0) lines.push(`— ${meta.join(' · ')}`)
        lines.push('')
      }
    }
    return { markdown: lines.join('\n').trim(), count: entry.highlights.length }
  }
}

// ---------------------------------------------------------------------------
// LLM 动作（reading.explain / reading.translate 的 SSE 数据源）
// ---------------------------------------------------------------------------

const SELECTION_MAX = 2000
const STATE_MAX = 1500

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`
}

/** 课程状态摘要（大纲 + 掌握度看板，截断到预算内）——解释动作的课程上下文。 */
async function courseStateSummary(workspaceRoot: string): Promise<string> {
  const state = await loadCourseState(workspaceRoot).catch(() => null)
  if (state === null) return '（暂无课程状态）'
  const lines: string[] = [`课程：${state.title}`]
  for (const chapter of state.chapters.slice(0, 12)) {
    lines.push(`- ${chapter.title}: ${chapter.concepts.map(c => c.name).join('、') || '（空）'}`)
  }
  const weak = state.concepts
    .filter(concept => concept.mastery < 0.6)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 8)
  if (weak.length > 0) {
    lines.push('掌握度较弱的概念：')
    for (const concept of weak) lines.push(`- ${concept.name} ${Math.round(concept.mastery * 100)}%`)
  }
  return truncate(lines.join('\n'), STATE_MAX)
}

export interface ReadingActionInput {
  readonly workspaceRoot: string
  readonly source: string
  readonly selection: string
}

/**
 * 阅读 LLM 动作：流式产出 token 帧，done 帧带用量摘要。路由用
 * `llm.read_model`（缺省主模型）、思考档位缺省 off（与判题路径一致），
 * 不复用 judge_model——判题与阅读语义不同，共用会互相抢占配置。
 */
export async function* runReadingAction(
  kind: 'explain' | 'translate',
  input: ReadingActionInput,
  getConfig: () => Promise<ResolvedChatConfig | null>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const config = await getConfig()
  if (config === null || config.baseUrl === '' || config.model === '') {
    yield { event: 'error', data: { code: 'READING_NOT_CONFIGURED', message: '尚未配置模型：请先在 设置 → 模型配置 保存供应商' } }
    return
  }
  const model = config.readModel ?? config.model
  const effort = config.readEffort ?? 'off'
  const maxTokens = kind === 'explain' ? 800 : 600
  const client = createDeepSeekToolClient({
    ...config,
    model,
    reasoningEffort: ReasoningEffortId(effort),
    maxTokens,
  })
  const system = kind === 'explain'
    ? [
      '你是 StudyClaw 的阅读讲解助手。学生正在精读课程资料并选中了一段文本。',
      '请结合下方课程状态，把这段内容讲懂：先点明它属于哪个概念/章节，再解释关键点，',
      '最后给一个记忆锚点。不要泛泛百科，不要重复学生已经选中的原文。',
      '使用规范 Markdown 排版，强调符号紧贴内容（如 **关键点**），代码放在代码围栏内。',
      '',
      '## 课程状态',
      await courseStateSummary(input.workspaceRoot),
    ].join('\n')
    : [
      '你是翻译引擎。把用户选中的文本在中文与英文之间互译（按文本主要语言判断方向），',
      '只输出译文本身，不要解释、不要加引号、保留原有格式与术语。',
    ].join('\n')
  const user = kind === 'explain'
    ? `资料：${input.source}\n\n选中文本：\n${truncate(input.selection, SELECTION_MAX)}`
    : truncate(input.selection, SELECTION_MAX)
  let text = ''
  try {
    for await (const chunk of client.request(system, [{ role: 'user', content: user }], null, signal)) {
      if (chunk.kind === 'text') {
        text += chunk.delta
        yield { event: 'token', data: { delta: chunk.delta } }
      }
    }
  } catch (error) {
    if (signal?.aborted === true) return
    yield { event: 'error', data: { code: 'READING_FAILED', message: error instanceof Error ? error.message : String(error) } }
    return
  }
  yield { event: 'done', data: { kind, model, chars: text.length } }
}
