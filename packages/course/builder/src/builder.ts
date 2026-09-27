/**
 * Checksums + build orchestration: SHA-256 fingerprint table, incremental
 * diffing, syllabus merge (id-preserving union), task pool management
 * (retire changed-file cards, id-collision bumping), progress seeding, and
 * granularity regeneration. Ported from Python `workspace.py` checksums +
 * `builder.py::CourseBuilder`.
 * @module @studyclaw/course-builder/src/builder
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { withCourseLock } from '@studyclaw/tools'
import { MarkdownIngestor } from './ingestor.ts'
import { extractSourceText } from './extract.ts'
import { graphAdjacency, projectChapterDependencies, type DependencyInferrerLike } from './dep-infer.ts'
import { applySyllabusQualityGuard } from './quality-guard.ts'
import { answerPositionSkewWarning, enforceTaskQuality } from './quality.ts'
import { harnessTask, syllabus, type Chapter, type HarnessTask, type IngestArtifact, type Syllabus } from './models.ts'
import type { ProgressRecordMutable } from './progress.ts'

export const DEFAULT_SOURCE_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx', '.xlsx', '.html', '.htm']

/** 项目即课程布局下的状态/元数据文件名——就地扫描资料时一律跳过。 */
export const COURSE_STATE_FILES = new Set([
  'syllabus.json',
  'progress.md',
  'notes.md',
  '.checksums',
  '.source-root.json',
])

/**
 * 所有应用自有产物（大纲/题池/进度/会话/校验和）都收在
 * `<workspaceRoot>/.studyclaw/` 下；用户资料留在原地只读。
 */
export function stateDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.studyclaw')
}

const LEGACY_LAYOUT_MARKER = '.layout-v2'
const LEGACY_LAYOUT_ARTIFACTS = ['syllabus.json', 'progress.md', 'notes.md', 'tasks', 'history', 'sources', 'courses', '.checksums', '.source-root.json']

/**
 * One-shot layout migration: moves pre-v2 root-level artifacts into
 * `.studyclaw/`. Idempotent and marker-guarded; existing files inside the
 * state directory always win over the legacy copy.
 */
export async function migrateLegacyLayout(workspaceRoot: string): Promise<void> {
  const stateDir = stateDirOf(workspaceRoot)
  const marker = join(stateDir, LEGACY_LAYOUT_MARKER)
  if ((await stat(marker).catch(() => null)) !== null) return
  const found: string[] = []
  for (const name of LEGACY_LAYOUT_ARTIFACTS) {
    if ((await stat(join(workspaceRoot, name)).catch(() => null)) !== null) found.push(name)
  }
  await mkdir(stateDir, { recursive: true })
  for (const name of found) {
    const to = join(stateDir, name)
    if ((await stat(to).catch(() => null)) !== null) continue
    await rename(join(workspaceRoot, name), to).catch(() => undefined)
  }
  if (found.length > 0) console.log(`[studyclaw] 布局迁移: ${found.join(', ')} -> .studyclaw/`)
  await atomicWrite(marker, 'v2' + String.fromCharCode(10))
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}

export interface BuildReport {
  added: string[]
  modified: string[]
  unchanged: string[]
  removed: string[]
  tasksGenerated: number
  conceptsSeeded: number
  degraded: string[]
  version: string
}

function emptyReport(): BuildReport {
  return { added: [], modified: [], unchanged: [], removed: [], tasksGenerated: 0, conceptsSeeded: 0, degraded: [], version: '1.0.0' }
}

export interface TaskGenerator {
  generateTasks(chunk: IngestArtifact['chunks'][number], count: number): Promise<HarnessTask[]>
}

/** Scan `sources/` producing `{relative: "sha256:<hex>"}` (Python parity). */
export async function computeChecksums(
  sourcesDir: string,
  extensions: readonly string[] = DEFAULT_SOURCE_EXTENSIONS,
  excludedDirs: ReadonlySet<string> | null = null,
  skipHiddenDirs = false,
  excludedFiles: ReadonlySet<string> = COURSE_STATE_FILES,
): Promise<Record<string, string>> {
  const table: Record<string, string> = {}
  if (!(await stat(sourcesDir).catch(() => null))?.isDirectory()) return table
  const excluded = excludedDirs ?? new Set<string>()

  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = relative(sourcesDir, path).split(sep).join('/')
      const parentParts = rel.split('/').slice(0, -1)
      if (parentParts.some(part => excluded.has(part))) continue
      if (skipHiddenDirs && parentParts.some(part => part.startsWith('.'))) continue
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && extensions.includes(entry.name.toLowerCase().match(/\.[^.]*$/)?.[0] ?? '')
        && !excludedFiles.has(entry.name)) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex')
        table[rel] = `sha256:${digest}`
      }
    }
  }
  await walk(sourcesDir)
  return table
}

async function atomicWrite(path: string, content: string): Promise<void> {
  // v2 布局：产物在 .studyclaw/ 下，首次写入前目录可能还不存在。
  await mkdir(dirname(path), { recursive: true })
  // T-3：固定 `path + '.tmp'` 在并发写（跨进程 regenerateSyllabus / 同进程双
  // regenerate / 与 progress.ts 同目录写）时互踩——两个写流交错写同一 tmp，
  // rename 出混合内容（syllabus.json 损坏 → loadSyllabus 回退空大纲）或
  // ENOENT。加 pid + 随机后缀（progress.ts / storage-json atomic.ts 同口径）。
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

async function loadJson<T>(path: string): Promise<T | null> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function loadSyllabus(courseDir: string): Promise<Syllabus> {
  const path = join(stateDirOf(courseDir), 'syllabus.json')
  const parsed = await loadJson<unknown>(path)
  if (parsed !== null) {
    try {
      return syllabus.parse(parsed)
    } catch {
      // Corrupt syllabus: fall back to a fresh draft.
    }
  }
  return { course_id: courseDir.split(/[\\/]/).pop() ?? 'course', title: courseDir.split(/[\\/]/).pop() ?? 'course', version: '1.0.0', granularity: 'fine', chapters: [], adjacency: {} }
}

export async function loadTaskPool(courseDir: string): Promise<HarnessTask[]> {
  const tasksDir = join(stateDirOf(courseDir), 'tasks')
  if (!(await stat(tasksDir).catch(() => null))?.isDirectory()) return []
  const pool: HarnessTask[] = []
  for (const name of (await readdir(tasksDir)).sort()) {
    if (!name.endsWith('.json')) continue
    const parsed = await loadJson<unknown>(join(tasksDir, name))
    if (parsed !== null) {
      try {
        pool.push(harnessTask.parse(parsed))
      } catch {
        // Corrupt card skipped.
      }
    }
  }
  return pool
}

export async function writeTaskPool(courseDir: string, pool: HarnessTask[]): Promise<void> {
  const tasksDir = join(stateDirOf(courseDir), 'tasks')
  await mkdir(tasksDir, { recursive: true })
  const written = new Set<string>()
  for (let index = 0; index < pool.length; index += 1) {
    const path = join(tasksDir, `task_${String(index + 1).padStart(4, '0')}.json`)
    await atomicWrite(path, JSON.stringify(pool[index]!, null, 2) + '\n')
    written.add(path)
  }
  for (const name of await readdir(tasksDir)) {
    const path = join(tasksDir, name)
    if (!written.has(path)) await (await import('node:fs/promises')).unlink(path).catch(() => {})
  }
}

function nextFreeId(prefix: string, used: Set<string>): string {
  let number = 1
  let candidate = `${prefix}_${String(number).padStart(3, '0')}`
  while (used.has(candidate)) {
    number += 1
    candidate = `${prefix}_${String(number).padStart(3, '0')}`
  }
  return candidate
}

function bumpPatch(version: string): string {
  const parts = version.split('.')
  if (parts.length !== 3 || !/^\d+$/.test(parts[2]!)) return version
  parts[2] = String(Number(parts[2]!) + 1)
  return parts.join('.')
}

/** PERF-1：有界并发池——按 limit 起固定数量的 worker 顺序认领队列项，
 * 结果按下标回填，顺序与输入一致；失败向上冒泡（与旧串行行为一致）。
 *  T-6：首败即停——旧实现 Promise.all 拒绝后其余 worker 仍把剩余队列全部跑完
 *  才弃结果，批量出题里一个单元失败会白烧完全部剩余 LLM 调用（计费+耗时）；
 *  在途单元跑完自然结算，但不再认领新项。 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit), items.length))
  const results = new Array<R>(items.length)
  let cursor = 0
  let failed = false
  const workers = Array.from({ length: Math.max(width, items.length === 0 ? 0 : 1) }, async () => {
    while (cursor < items.length && !failed) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index]!)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * One course's incremental build orchestrator. `generator` is injected so
 * tests can run offline; the host wires the LLM-backed generator.
 */
export class CourseBuilder {
  constructor(
    readonly courseDir: string,
    readonly generator: TaskGenerator,
    readonly depInferrer: DependencyInferrerLike | null = null,
    readonly ingestor: MarkdownIngestor | null = null,
    readonly granularity: 'fine' | 'coarse' = 'fine',
    readonly extensions: readonly string[] = DEFAULT_SOURCE_EXTENSIONS,
    readonly sourceRoot: string | null = null,
    readonly checksumsDir: string | null = null,
    readonly excludedSourceDirs: ReadonlySet<string> | null = null,
    readonly skipHiddenSourceDirs = false,
    readonly excludedSourceFiles: ReadonlySet<string> = COURSE_STATE_FILES,
  ) {}

  private sourcesDir(): string {
    return this.sourceRoot ?? join(this.courseDir, 'sources')
  }

  async build(tasksPerChunk = 2, onProgress?: (finished: number, total: number, currentFile: string) => void, granularity?: 'fine' | 'coarse', maxConcurrency = 4): Promise<BuildReport> {
    if (granularity !== undefined && granularity !== this.granularity) {
      // Granularity override is handled by callers (regenerateSyllabus); the
      // build path keeps the constructor default, matching Python's F7 scope.
    }
    if (!(await stat(this.courseDir).catch(() => null))?.isDirectory()) {
      throw new BuildError(`课程目录不存在: ${this.courseDir}（先运行 studyclaw init）`)
    }
    const sourcesDir = this.sourcesDir()
    const current = await computeChecksums(sourcesDir, this.extensions, this.excludedSourceDirs, this.skipHiddenSourceDirs, this.excludedSourceFiles)
    const stored = await this.loadChecksums()
    const report = emptyReport()
    // 首建判定：既有指纹但无题卡池也无大纲 → 视为全量首建（Python parity）。
    if (Object.keys(stored).length > 0 && (await loadTaskPool(this.courseDir)).length === 0) {
      const hasSyllabus = (await stat(join(stateDirOf(this.courseDir), 'syllabus.json')).catch(() => null)) !== null
      if (!hasSyllabus) {
        Object.keys(stored).forEach(key => { delete stored[key] })
      }
    }

    for (const name of Object.keys(current).sort()) {
      if (!(name in stored)) report.added.push(name)
      else if (current[name] !== stored[name]) report.modified.push(name)
      else report.unchanged.push(name)
    }
    report.removed = Object.keys(stored).filter(name => !(name in current)).sort()
    const changed = report.added.length > 0 || report.modified.length > 0 || report.removed.length > 0

    if (!changed) {
      const existing = await loadSyllabus(this.courseDir)
      report.version = existing.version
      // Even when nothing changed, reconcile progress rows with the current
      // syllabus. This catches: (a) stale progress.md from earlier broken
      // builds (e.g. orphaned Response/Anthropic rows before ingestor fix),
      // (b) a deleted/empty progress.md that needs re-seeding, (c) chapter
      // titles that were refreshed without any source file changing.
      report.conceptsSeeded = await withCourseLock(this.courseDir, () => this.seedProgress())
      return report
    }

    const artifacts: IngestArtifact[] = []
    const changedFiles = [...report.added, ...report.modified]
    // PERF-1 重构：摄取（本地解析，快）保持按文件串行；LLM 生成（慢）
    // 扁平化为 chunk 粒度的任务队列后按 max_concurrency 有界并行消费——
    // 旧实现双层全串行，56 chunk × ~10s 就是分钟级空白等待。
    interface GenerateUnit { readonly file: string; readonly chunk: IngestArtifact['chunks'][number] }
    const generatePlan: GenerateUnit[] = []
    for (let index = 0; index < changedFiles.length; index += 1) {
      const name = changedFiles[index]!
      if (onProgress !== undefined) onProgress(index, changedFiles.length, name)
      const path = join(sourcesDir, name)
      const ext = name.toLowerCase().match(/\.[^.]*$/)?.[0] ?? ''
      const ingestor = new MarkdownIngestor(undefined, this.granularity)
      let artifact: IngestArtifact
      try {
        if (ext === '.md' || ext === '.txt') {
          artifact = await ingestor.parseAndChunk(path, this.courseDir.split(/[\\/]/).pop() ?? 'course')
        } else {
          // 抽取文档文本后委托同一 MarkdownIngestor 走双层大纲/切片（Python PdfIngestor 语义）。
          const markdown = await extractSourceText(path, ext)
          artifact = ingestor.parseText(markdown, name, this.courseDir.split(/[\\/]/).pop() ?? 'course')
        }
      } catch {
        report.degraded.push(name)
        continue
      }
      // Carry the checksum identity (nested paths included) into every chunk.
      const normalized: IngestArtifact = {
        ...artifact,
        source_file: name,
        chunks: artifact.chunks.map(chunk => ({ ...chunk, source_ref: { ...chunk.source_ref, file: name } })),
      }
      // F-17：空/纯文本文档零章节不再静默成功——标入 degraded 显式告警。
      if (normalized.chunks.length === 0) {
        report.degraded.push(`${name}（未解析出任何概念块）`)
        continue
      }
      artifacts.push(normalized)
      for (const chunk of normalized.chunks) {
        if (chunk.concept_id !== '') generatePlan.push({ file: name, chunk })
      }
    }
    const generatedAll: HarnessTask[] = []
    let finished = 0
    await mapWithConcurrency(generatePlan, maxConcurrency, async unit => {
      generatedAll.push(...await this.generator.generateTasks(unit.chunk, tasksPerChunk))
      finished += 1
      if (onProgress !== undefined) onProgress(finished, generatePlan.length, `${unit.file} · ${unit.chunk.title}`)
    })
    // 题卡质量闸（零 LLM）：去重/长度失衡/答案键越界，不合格卡进 degraded。
    const gate = enforceTaskQuality(generatedAll)
    for (const drop of gate.dropped) report.degraded.push(`${drop.taskId}：${drop.reason}`)
    const skew = answerPositionSkewWarning(gate.answerPositionHistogram)
    if (skew !== null) console.warn(`[quality-gate] ${skew}`)
    // M2：旧卡退役移到生成成功之后——旧实现先删后生成，生成失败（LLM 报错/
    // 限流）时旧卡已被删且 checksums 未保存，连续失败会把题池越削越空。
    // 课程锁只包无 LLM 的写段（快），生成与依赖推断留在锁外——文件锁的
    // 30s 超时不会误伤并发评测。
    await withCourseLock(this.courseDir, async () => {
      await this.updateTaskPool([...report.added, ...report.modified], report)
      report.tasksGenerated = await this.mergeTasks(gate.kept)
      await this.mergeSyllabus(artifacts, report)
    })
    if (onProgress !== undefined) onProgress(changedFiles.length, changedFiles.length, '')

    await this.applyDependencyInference(artifacts, report)
    await withCourseLock(this.courseDir, async () => {
      report.conceptsSeeded = await this.seedProgress()
      await this.saveChecksums(current)
    })
    return report
  }

  /** Granularity regeneration: ingest + union merge + seeding, no re-generation. */
  async regenerateSyllabus(granularity: 'fine' | 'coarse'): Promise<BuildReport> {
    if (granularity !== 'fine' && granularity !== 'coarse') throw new Error('granularity 取值 fine | coarse')
    const sourcesDir = this.sourcesDir()
    const current = await computeChecksums(sourcesDir, this.extensions, this.excludedSourceDirs, this.skipHiddenSourceDirs, this.excludedSourceFiles)
    const report = emptyReport()
    // L6：无变更路径此前沿用 emptyReport 的 '1.0.0' 假版本——以磁盘上的
    // 当前版本为基线，mergeSyllabus 增长时再自行 bump。
    report.version = (await loadSyllabus(this.courseDir)).version
    const artifacts: IngestArtifact[] = []
    const ingestor = new MarkdownIngestor(undefined, granularity)
    for (const name of Object.keys(current).sort()) {
      const ext = name.toLowerCase().match(/\.[^.]*$/)?.[0] ?? ''
      try {
        let artifact: IngestArtifact
        if (ext === '.md' || ext === '.txt') {
          artifact = await ingestor.parseAndChunk(join(sourcesDir, name), this.courseDir.split(/[\\/]/).pop() ?? 'course')
        } else {
          const markdown = await extractSourceText(join(sourcesDir, name), ext)
          artifact = ingestor.parseText(markdown, name, this.courseDir.split(/[\\/]/).pop() ?? 'course')
        }
        artifacts.push({
          ...artifact,
          source_file: name,
          chunks: artifact.chunks.map(chunk => ({ ...chunk, source_ref: { ...chunk.source_ref, file: name } })),
        })
        report.added.push(name)
      } catch {
        report.degraded.push(name)
      }
    }
    await withCourseLock(this.courseDir, () => this.mergeSyllabus(artifacts, report))
    await this.applyDependencyInference(artifacts, report)
    await withCourseLock(this.courseDir, async () => {
      report.conceptsSeeded = await this.seedProgress()
      await this.saveChecksums(current)
    })
    const existing = await loadSyllabus(this.courseDir)
    if (existing.granularity !== granularity) {
      // T-3：granularity 覆写此前的锁外写——与并发 build/regenerate 的
      // mergeSyllabus（上方锁内）竞争同一 syllabus.json，陈旧全量写会覆盖
      // 合并结果。小写段无 LLM，包进课程锁；锁内重读最新版再覆写，避免
      // 用锁外读到的旧快照覆盖并发合并。
      await withCourseLock(this.courseDir, async () => {
        const latest = await loadSyllabus(this.courseDir)
        if (latest.granularity !== granularity) {
          await atomicWrite(join(stateDirOf(this.courseDir), 'syllabus.json'), JSON.stringify({ ...latest, granularity }, null, 2) + '\n')
        }
      })
      report.version = existing.version
    }
    return report
  }

  private async mergeTasks(generated: HarnessTask[]): Promise<number> {
    const pool = await loadTaskPool(this.courseDir)
    const used = new Set(pool.map(task => task.task_id))
    const fresh: HarnessTask[] = []
    for (const task of generated) {
      if (used.has(task.task_id)) {
        const prefix = task.concept_id.replace(/^c_/, '')
        const renamed = { ...task, task_id: nextFreeId(prefix, used) }
        used.add(renamed.task_id)
        fresh.push(renamed)
      } else {
        used.add(task.task_id)
        fresh.push(task)
      }
    }
    if (fresh.length === 0) return 0
    await writeTaskPool(this.courseDir, [...pool, ...fresh])
    return fresh.length
  }

  private async updateTaskPool(changedFiles: string[], report: BuildReport): Promise<void> {
    const stale = new Set([...changedFiles, ...report.removed])
    if (stale.size === 0) return
    const pool = await loadTaskPool(this.courseDir)
    const kept = pool.filter(task => task.source_ref === null || task.source_ref.file === null || !stale.has(task.source_ref.file))
    if (kept.length !== pool.length) await writeTaskPool(this.courseDir, kept)
  }

  private async mergeSyllabus(artifacts: IngestArtifact[], report: BuildReport): Promise<void> {
    const path = join(stateDirOf(this.courseDir), 'syllabus.json')
    const existing = await loadSyllabus(this.courseDir)
    const byId = new Map(existing.chapters.map((chapter, index) => [chapter.id, index]))
    const merged: Chapter[] = [...existing.chapters]
    let grew = false
    for (const artifact of artifacts) {
      for (const chapter of artifact.syllabus.chapters) {
        const index = byId.get(chapter.id)
        if (index !== undefined) {
          const current = merged[index]!
          const known = new Set(current.concepts.map(concept => concept.id))
          const fresh = chapter.concepts.filter(concept => !known.has(concept.id))
          if (fresh.length > 0) {
            merged[index] = { ...current, concepts: [...current.concepts, ...fresh] }
            grew = true
          }
        } else {
          byId.set(chapter.id, merged.length)
          merged.push(chapter)
          grew = true
        }
      }
    }
    if (!grew) return
    const newVersion = (await stat(path).catch(() => null)) !== null ? bumpPatch(existing.version) : existing.version
    const updated: Syllabus = {
      ...existing,
      version: newVersion,
      granularity: this.granularity,
      chapters: merged,
    }
    // 质量守卫：净化名称空白（安全修复），其余问题上报 degraded 不阻塞。
    const guarded = applySyllabusQualityGuard(updated)
    if (guarded.issues.length > 0) report.degraded.push('syllabus-quality')
    await atomicWrite(path, JSON.stringify(guarded.syllabus, null, 2) + '\n')
    report.version = updated.version
  }

  /**
   * LLM 概念级先修依赖推断（dep-infer）：merge 后对全书一次结构化调用，
   * 写回概念 prerequisites + 顶层 adjacency + 章节级 dependencies 投影。
   * LLM 未覆盖的概念保留既有依赖；推断失败降级 degraded，不阻塞构建。
   */
  private async applyDependencyInference(artifacts: IngestArtifact[], report: BuildReport): Promise<void> {
    if (this.depInferrer === null) return
    const existing = await loadSyllabus(this.courseDir)
    const totalConcepts = existing.chapters.reduce((sum, chapter) => sum + chapter.concepts.length, 0)
    if (totalConcepts === 0) return
    const snippets = new Map<string, string>()
    for (const artifact of artifacts) {
      for (const chunk of artifact.chunks) {
        if (chunk.concept_id === '') continue
        const prev = snippets.get(chunk.concept_id) ?? ''
        if (prev.length >= 600) continue
        snippets.set(chunk.concept_id, prev === '' ? chunk.content : `${prev}\n${chunk.content}`)
      }
    }
    const result = await this.depInferrer.infer(existing, snippets).catch(() => null)
    if (result === null) {
      report.degraded.push('dependencies')
      return
    }
    const byId = new Map(result.dependencies.map(entry => [entry.conceptId, entry.prerequisites]))
    // 并发丢失更新修复：LLM 推断在锁外跑（数十秒不能占课程锁，见上方的锁
    // 粒度取舍），但"读 syllabus → 合并 → 写回"必须整体进锁、且基于锁时刻
    // 从磁盘重读的最新版做合并——否则与并发 build/regenerateSyllabus 的锁内
    // mergeSyllabus 互相整文件覆盖，后写者静默丢掉先写者的章节/概念。
    // 推断结果按 conceptId 键控，对锁内新出现的概念自然落空（保留既有依赖）。
    await withCourseLock(this.courseDir, async () => {
      const fresh = await loadSyllabus(this.courseDir)
      let changed = false
      const chapters = fresh.chapters.map(chapter => ({
        ...chapter,
        concepts: chapter.concepts.map(concept => {
          const inferred = byId.get(concept.id)
          if (inferred === undefined) return concept // LLM 未覆盖 → 保留既有
          const next = [...new Set(inferred)]
          if (next.length === concept.prerequisites.length && next.every(id => concept.prerequisites.includes(id))) return concept
          changed = true
          return { ...concept, prerequisites: next }
        }),
      }))
      if (!changed) return
      const project = projectChapterDependencies(chapters)
      const updated: Syllabus = {
        ...fresh,
        version: bumpPatch(fresh.version),
        chapters: chapters.map(chapter => ({
          ...chapter,
          dependencies: project[chapter.id] ?? chapter.dependencies,
        })),
        adjacency: graphAdjacency(chapters),
      }
      await atomicWrite(join(stateDirOf(this.courseDir), 'syllabus.json'), JSON.stringify(updated, null, 2) + '\n')
      report.version = updated.version
    })
  }

  /**
   * Seed progress rows for new concepts and drop rows whose concept no
   * longer exists in the current syllabus. Preserves mastery/eval history
   * for concepts that survived the rebuild (by conceptId) and also
   * refreshes `name`/`chapter` fields so renamed chapters or split/merged
   * concepts always display the syllabus's current truth instead of stale
   * strings left over from earlier builds.
   */
  private async seedProgress(): Promise<number> {
    const syllabusPath = join(stateDirOf(this.courseDir), 'syllabus.json')
    if ((await stat(syllabusPath).catch(() => null)) === null) return 0
    const existingSyllabus = await loadSyllabus(this.courseDir)
    const { loadProgressBoard, saveProgressBoard } = await import('./progress.ts')
    const stateDir = stateDirOf(this.courseDir)
    let board = await loadProgressBoard(join(stateDir, 'progress.md'))

    // Build id → { name, chapter } map from current syllabus (truth source).
    const current = new Map<string, { name: string; chapter: string }>()
    for (const chapter of existingSyllabus.chapters) {
      for (const concept of chapter.concepts) {
        current.set(concept.id, { name: concept.name, chapter: chapter.title })
      }
    }

    // Drop rows whose conceptId is no longer in the syllabus (orphaned by
    // an earlier build's structure). Also refresh stale name/chapter fields
    // for rows that still exist (e.g. chapter renamed after ingestor fix).
    const existingById = new Map(board.concepts.map(r => [r.conceptId, r]))
    let changed = board.concepts.length !== current.size
    const refreshed = []
    for (const [conceptId, meta] of current) {
      const prior = existingById.get(conceptId)
      if (prior === undefined) {
        refreshed.push({
          conceptId, name: meta.name, chapter: meta.chapter,
          mastery: 0, evals: 0, passRate: 0, streak: 0, ef: 2.5,
          nextReviewAt: null, misattribution: 'none',
        })
        changed = true
      } else {
        const merged = { ...prior }
        if (merged.name !== meta.name) { (merged as ProgressRecordMutable).name = meta.name; changed = true }
        if (merged.chapter !== meta.chapter) { (merged as ProgressRecordMutable).chapter = meta.chapter; changed = true }
        refreshed.push(merged)
      }
    }

    const seeded = Math.max(0, current.size - existingById.size)
    board = { ...board, concepts: refreshed }

    if (changed) await saveProgressBoard(join(stateDir, 'progress.md'), board)
    return seeded
  }

  private async loadChecksums(): Promise<Record<string, string>> {
    const dir = this.checksumsDir ?? stateDirOf(this.courseDir)
    const parsed = await loadJson<Record<string, string>>(join(dir, '.checksums'))
    return parsed ?? {}
  }

  private async saveChecksums(table: Record<string, string>): Promise<void> {
    const dir = this.checksumsDir ?? stateDirOf(this.courseDir)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, '.checksums'), JSON.stringify(table, null, 2) + '\n')
  }
}


