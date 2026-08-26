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
import { join, relative, sep } from 'node:path'
import { MarkdownIngestor } from './ingestor.ts'
import { extractSourceText } from './extract.ts'
import { graphAdjacency, projectChapterDependencies, type DependencyInferrerLike } from './dep-infer.ts'
import { applySyllabusQualityGuard } from './quality-guard.ts'
import { harnessTask, syllabus, type Chapter, type HarnessTask, type IngestArtifact, type Syllabus } from './models.ts'

export const DEFAULT_SOURCE_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx', '.xlsx', '.html', '.htm']

/** 项目即课程布局下的状态/元数据文件名——就地扫描资料时一律跳过。 */
export const COURSE_STATE_FILES = new Set([
  'syllabus.json',
  'progress.md',
  'notes.md',
  '.checksums',
  '.source-root.json',
])

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
  const tmp = path + '.tmp'
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
  const path = join(courseDir, 'syllabus.json')
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
  const tasksDir = join(courseDir, 'tasks')
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
  const tasksDir = join(courseDir, 'tasks')
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

  async build(tasksPerChunk = 2, onProgress?: (finished: number, total: number, currentFile: string) => void, granularity?: 'fine' | 'coarse'): Promise<BuildReport> {
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
      const hasSyllabus = (await stat(join(this.courseDir, 'syllabus.json')).catch(() => null)) !== null
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
      return report
    }

    await this.updateTaskPool([...report.added, ...report.modified], report)
    const artifacts: IngestArtifact[] = []
    const changedFiles = [...report.added, ...report.modified]
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
      artifacts.push(normalized)
      report.tasksGenerated += await this.generateFor(normalized, tasksPerChunk)
    }
    if (onProgress !== undefined) onProgress(changedFiles.length, changedFiles.length, '')

    await this.mergeSyllabus(artifacts, report)
    await this.applyDependencyInference(artifacts, report)
    report.conceptsSeeded = await this.seedProgress()
    await this.saveChecksums(current)
    return report
  }

  /** Granularity regeneration: ingest + union merge + seeding, no re-generation. */
  async regenerateSyllabus(granularity: 'fine' | 'coarse'): Promise<BuildReport> {
    if (granularity !== 'fine' && granularity !== 'coarse') throw new Error('granularity 取值 fine | coarse')
    const sourcesDir = this.sourcesDir()
    const current = await computeChecksums(sourcesDir, this.extensions, this.excludedSourceDirs, this.skipHiddenSourceDirs, this.excludedSourceFiles)
    const report = emptyReport()
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
    await this.mergeSyllabus(artifacts, report)
    await this.applyDependencyInference(artifacts, report)
    report.conceptsSeeded = await this.seedProgress()
    await this.saveChecksums(current)
    const existing = await loadSyllabus(this.courseDir)
    if (existing.granularity !== granularity) {
      await atomicWrite(join(this.courseDir, 'syllabus.json'), JSON.stringify({ ...existing, granularity }, null, 2) + '\n')
      report.version = existing.version
    }
    return report
  }

  private async generateFor(artifact: IngestArtifact, tasksPerChunk: number): Promise<number> {
    const chunks = artifact.chunks.filter(chunk => chunk.concept_id !== '')
    if (chunks.length === 0) return 0
    const generated: HarnessTask[] = []
    for (const chunk of chunks) {
      generated.push(...await this.generator.generateTasks(chunk, tasksPerChunk))
    }
    return this.mergeTasks(generated)
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
    const path = join(this.courseDir, 'syllabus.json')
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
    let changed = false
    const chapters = existing.chapters.map(chapter => ({
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
      ...existing,
      version: bumpPatch(existing.version),
      chapters: chapters.map(chapter => ({
        ...chapter,
        dependencies: project[chapter.id] ?? chapter.dependencies,
      })),
      adjacency: graphAdjacency(chapters),
    }
    await atomicWrite(join(this.courseDir, 'syllabus.json'), JSON.stringify(updated, null, 2) + '\n')
    report.version = updated.version
  }

  /** Seed progress rows for new concepts; existing mastery data never regresses. */
  private async seedProgress(): Promise<number> {
    const syllabusPath = join(this.courseDir, 'syllabus.json')
    if ((await stat(syllabusPath).catch(() => null)) === null) return 0
    const existingSyllabus = await loadSyllabus(this.courseDir)
    const { loadProgressBoard, saveProgressBoard, upsertProgressRecord } = await import('./progress.ts')
    let board = await loadProgressBoard(join(this.courseDir, 'progress.md'))
    const known = new Set(board.concepts.map(record => record.conceptId))
    let seeded = 0
    for (const chapter of existingSyllabus.chapters) {
      for (const concept of chapter.concepts) {
        if (known.has(concept.id)) continue
        board = upsertProgressRecord(board, {
          conceptId: concept.id, name: concept.name, chapter: chapter.title, mastery: 0, evals: 0,
          passRate: 0, ef: 2.5, nextReviewAt: null, misattribution: 'none',
        })
        known.add(concept.id)
        seeded += 1
      }
    }
    if (seeded > 0) await saveProgressBoard(join(this.courseDir, 'progress.md'), board)
    return seeded
  }

  private async loadChecksums(): Promise<Record<string, string>> {
    const dir = this.checksumsDir ?? this.sourcesDir()
    const parsed = await loadJson<Record<string, string>>(join(dir, '.checksums'))
    return parsed ?? {}
  }

  private async saveChecksums(table: Record<string, string>): Promise<void> {
    const dir = this.checksumsDir ?? this.sourcesDir()
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, '.checksums'), JSON.stringify(table, null, 2) + '\n')
  }
}


