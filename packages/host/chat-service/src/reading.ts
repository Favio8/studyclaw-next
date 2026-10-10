/**
 * Reading service（PRD 需求三）：资料精读的标注存储与 LLM 动作。
 *
 * 数据契约（文件即状态）：`<课程>/.studyclaw/annotations.json`，单课程单文件，
 * 人类可读。定位用双锚——几何 rects 归一化到 0-1（相对页面宽高），文本 quote
 * （Hypothesis 式 text/prefix/suffix）供版面轻微变化时重定位。
 *
 * 并发：Host 是单进程 Node，每个 RPC 在课程锁内完成"读 → 改 → 写"，
 * 多标签页只是请求先后到达，不会交叉在同一文件的读-改-写中间。
 * 损坏：JSON 解析失败 → 重命名 `.bak-<时间戳>` + 空结构重建，响应带 warning，
 * 阅读功能不整体不可用（storage-domain 的 quarantine 是记录级机制，不适用
 * 于裸 JSON 文件）。
 * @module @studyclaw/chat-service/src/reading
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSourceRef, withCourseLock } from '@studyclaw/tools'
import { loadCourseState } from '@studyclaw/session'
import type { ResolvedChatConfig } from './config.ts'
import { createDeepSeekToolClient } from './adapter.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

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

export type ReadingViewKind = 'pdf' | 'markdown' | 'unsupported'

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
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'markdown'
  return 'unsupported'
}

function emptyFile(): AnnotationsFile {
  return { version: 1, sources: {} }
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

/** 读取标注文件；损坏时备份重建并报告 recovered。 */
async function readAnnotations(stateDir: string): Promise<{ file: AnnotationsFile; recovered: boolean }> {
  const path = annotationsPathOf(stateDir)
  const raw = await readFile(path, 'utf8').catch(() => '')
  if (raw.trim() === '') return { file: emptyFile(), recovered: false }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { file: emptyFile(), recovered: true }
    const sources = (parsed as { sources?: unknown }).sources
    if (typeof sources !== 'object' || sources === null) return { file: emptyFile(), recovered: true }
    return { file: { version: 1, sources: sources as Record<string, SourceAnnotations> }, recovered: false }
  } catch {
    const backup = `${path}.bak-${Date.now().toString(36)}`
    await rename(path, backup).catch(() => {
      // 备份失败（如权限）不阻塞重建：空结构优先保证阅读可用。
    })
    return { file: emptyFile(), recovered: true }
  }
}

async function writeAnnotations(stateDir: string, file: AnnotationsFile): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const path = annotationsPathOf(stateDir)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function sourceEntry(file: AnnotationsFile, source: string): SourceAnnotations {
  const existing = file.sources[source]
  if (existing !== undefined && Array.isArray(existing.highlights)) return existing
  const fresh: SourceAnnotations = { progress: { ...EMPTY_PROGRESS }, highlights: [] }
  file.sources[source] = fresh
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
    const { file, recovered } = await readAnnotations(stateDir)
    const entry = sourceEntry(file, source)
    const target = await resolveSource(workspaceRoot, source).catch(() => null)
    const exists = target !== null && await readFile(target, 'utf8').then(() => true).catch(() => false)
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
    const { file } = await readAnnotations(join(workspaceRoot, '.studyclaw'))
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
  async readText(workspaceRoot: string, source: string): Promise<{ text: string; truncated: boolean }> {
    const target = await resolveSource(workspaceRoot, source)
    if (!/\.(md|txt)$/i.test(target)) {
      throw new Error('source 必须是课程资料根目录下的 .md/.txt 文件')
    }
    const raw = await readFile(target, 'utf8').catch(() => null)
    if (raw === null) throw new Error('资料不存在或不可读')
    const MAX = 200_000
    return { text: raw.length > MAX ? raw.slice(0, MAX) : raw, truncated: raw.length > MAX }
  }

  async exportMarkdown(workspaceRoot: string, source: string): Promise<{ markdown: string; count: number }> {
    const { file } = await readAnnotations(join(workspaceRoot, '.studyclaw'))
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
