/**
 * Course service: the host-side seam for the build/learning surface —
 * syllabus, progress, mastery, quiz, file enumeration, sync build, URL
 * ingest, card creation, dynamic cards, eval submission, jobs, tools list,
 * and metrics. Wires CourseBuilder + LlmTaskGenerator + RubricEvaluator over
 * the config-backed LLM client.
 * @module @studyclaw/chat-service/src/course
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import {
  CourseBuilder,
  DEFAULT_SOURCE_EXTENSIONS,
  LlmTaskGenerator,
  loadSyllabus,
  loadTaskPool,
  writeTaskPool,
  loadProgressBoard,
  saveProgressBoard,
  upsertProgressRecord,
  type BuildReport,
  type Syllabus,
  type TaskGenerator,
  reviewSchedule,
} from '@studyclaw/course-builder'
import { DependencyInferrer } from '@studyclaw/course-builder'
import {
  RubricEvaluator,
  generateDynamicCards,
  pickTasks,
  quizView,
  readGlobalMemory,
  heatmap,
  heatmapDay,
} from '@studyclaw/learning'
import { createDeepSeekToolClient } from './adapter.ts'
import { buildDefaultSpecs } from '@studyclaw/course-builder'
import { buildGenericSpecs, INPLACE_SOURCE_EXCLUDED_DIRS } from '@studyclaw/tools'
import type { ResolvedChatConfig } from './config.ts'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionEventStore, SessionStore, utcTs } from '@studyclaw/session'
import { loadChatConfig } from './config.ts'

export class CourseNotFoundError extends Error {
  constructor(courseId: string) {
    super(`课程不存在: ${courseId}`)
    this.name = 'CourseNotFoundError'
  }
}

function courseDirOf(workspaceRoot: string, courseId: string): string {
  if (courseId === '' || /[\/]/.test(courseId) || courseId.includes('..') || courseId.startsWith('.')) {
    throw new CourseNotFoundError(courseId)
  }
  // 项目即课程：courseId = 项目根 basename；不匹配视为课程不存在（避免跨项目串数据）。
  const expected = basename(workspaceRoot)
  if (courseId !== expected) throw new CourseNotFoundError(courseId)
  return workspaceRoot
}

async function requireCourse(workspaceRoot: string, courseId: string): Promise<string> {
  const dir = courseDirOf(workspaceRoot, courseId)
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new CourseNotFoundError(courseId)
  return dir
}

/** 项目即课程的项目构建器：资料/校验文件都在项目根（就地扫描，排除状态目录）。 */
function projectBuilder(dir: string, generator: TaskGenerator, depInferrer: DependencyInferrer | null): CourseBuilder {
  return new CourseBuilder(dir, generator, depInferrer, null, 'fine', DEFAULT_SOURCE_EXTENSIONS, dir, dir, INPLACE_SOURCE_EXCLUDED_DIRS, true)
}

interface BuildContext {
  readonly workspaceRoot: string
  readonly config: ResolvedChatConfig | null
}

export async function configForSession(workspaceRoot: string, courseId: string, sessionId: string | null | undefined, fallback: ResolvedChatConfig | null): Promise<ResolvedChatConfig | null> {
  if (sessionId === null || sessionId === undefined || sessionId === '') return fallback
  const historyDir = join(courseDirOf(workspaceRoot, courseId), 'history')
  // Event logs are authoritative for migrated/live Agent sessions. The
  // legacy SessionStore remains the fallback for sessions not yet migrated.
  const events = new SessionEventStore(historyDir)
  const rows = await events.load(sessionId).catch(() => [])
  const eventSelection = [...rows].reverse().find(row => {
    if (row.type !== 'session/model' && row.type !== 'request/header' && row.type !== 'model/provenance') return false
    return typeof row.payload['provider'] === 'string' && String(row.payload['provider']) !== ''
      && typeof row.payload['model'] === 'string' && String(row.payload['model']) !== ''
  })
  if (eventSelection !== undefined) {
    return loadChatConfig(workspaceRoot, { providerId: String(eventSelection.payload['provider']), model: String(eventSelection.payload['model']) })
  }
  const selected = await new SessionStore(historyDir).latestModel(sessionId)
  if (selected === null) return fallback
  return loadChatConfig(workspaceRoot, { providerId: selected.provider, model: selected.model })
}

function generatorOf(ctx: BuildContext, _courseDir: string): LlmTaskGenerator | null {
  if (ctx.config === null || ctx.config.model === '' || ctx.config.baseUrl === '') return null
  return new LlmTaskGenerator(createDeepSeekToolClient(ctx.config), {
    model: ctx.config.model,
    provider: ctx.config.providerId || 'studyclaw',
    temperature: ctx.config.temperature,
  })
}

function inferrerOf(ctx: BuildContext): DependencyInferrer | null {
  if (ctx.config === null || ctx.config.model === '' || ctx.config.baseUrl === '') return null
  return new DependencyInferrer(createDeepSeekToolClient(ctx.config), {
    model: ctx.config.model,
    provider: ctx.config.providerId || 'studyclaw',
    temperature: ctx.config.temperature,
  })
}

export interface JobView {
  readonly jobId: string
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly progress: { total: number; finished: number; currentFile: string | null }
  readonly result: { syllabusVersion: string; tasksGenerated: number } | null
  readonly error: string | null
}

interface MutableJob {
  readonly jobId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: { total: number; finished: number; currentFile: string | null }
  result: { syllabusVersion: string; tasksGenerated: number } | null
  error: string | null
}

/** In-memory async build jobs (progress + polling, Python jobs.py parity). */
export class JobManager {
  private readonly jobs = new Map<string, MutableJob>()

  start(courseDir: string, courseId: string, ctx: BuildContext): string {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.jobs.set(jobId, { jobId, status: 'queued', progress: { total: 0, finished: 0, currentFile: null }, result: null, error: null })
    void this.run(jobId, courseDir, courseId, ctx)
    return jobId
  }

  private async run(jobId: string, courseDir: string, _courseId: string, ctx: BuildContext): Promise<void> {
    const job = this.jobs.get(jobId)!
    job.status = 'running'
    try {
      const generator = generatorOf(ctx, courseDir)
      if (generator === null) throw new Error('未配置模型端点（.studyclaw/config.yaml 缺少 llm 配置）')
      const builder = new CourseBuilder(courseDir, generator, inferrerOf(ctx))
      const report = await builder.build(2, (finished, total, currentFile) => {
        job.progress = { total, finished, currentFile: currentFile || null }
      })
      job.progress = { total: report.added.length + report.modified.length, finished: report.added.length + report.modified.length, currentFile: null }
      job.result = { syllabusVersion: report.version, tasksGenerated: report.tasksGenerated }
      job.status = 'done'
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    }
  }

  get(jobId: string): JobView | undefined {
    return this.jobs.get(jobId)
  }
}

export interface CourseService {
  syllabus(workspaceRoot: string, courseId: string): Promise<Syllabus>
  setGranularity(workspaceRoot: string, courseId: string, granularity: 'fine' | 'coarse'): Promise<Syllabus>
  progress(workspaceRoot: string, courseId: string): Promise<Record<string, unknown>>
  mastery(workspaceRoot: string, courseId: string): Promise<Record<string, unknown>>
  quiz(workspaceRoot: string, courseId: string, mode: 'review' | 'new', count: number, conceptId: string | null, dueOnly?: boolean): Promise<Array<Record<string, unknown>>>
  taskPool(workspaceRoot: string, courseId: string, conceptId: string | null, limit: number): Promise<Array<Record<string, unknown>>>
  files(workspaceRoot: string, courseId: string): Promise<Record<string, unknown>>
  workspaceFiles(workspaceRoot: string): Promise<Record<string, unknown>>
  sync(workspaceRoot: string, courseId: string, sessionId?: string | null): Promise<Record<string, unknown>>
  ingestUrl(workspaceRoot: string, courseId: string, url: string, title: string | null): Promise<Record<string, unknown>>
  createCards(workspaceRoot: string, courseId: string, payload: { content: string; title?: string | null; conceptId?: string | null; count?: number; sessionId?: string | null }): Promise<Record<string, unknown>>
  dynamicCards(workspaceRoot: string, courseId: string, payload: { taskId: string; misconception: string; content?: string | null; targetId?: string | null; count?: number; sessionId?: string | null }): Promise<Record<string, unknown>>
  evalSubmit(workspaceRoot: string, courseId: string, taskId: string, answer: string, sessionId?: string | null): AsyncGenerator<Record<string, unknown>>
  job(jobId: string): JobView | undefined
  tools(providerStatus?: Record<string, { available: boolean; reason: string | null; installAction: string | null }>): Array<Record<string, unknown>>
  heatmap(workspaceRoot: string, weeks: number): Promise<Record<string, unknown>>
  heatmapDay(workspaceRoot: string, date: string): Promise<Record<string, unknown>>
  buildJob(workspaceRoot: string, courseId: string): string | null
  createCourse(workspaceRoot: string, courseName: string, importPaths: string[]): Promise<Record<string, unknown>>
}

/** Assemble the course service for the active workspace. */
export function createCourseService(getConfig: () => Promise<ResolvedChatConfig | null>): CourseService {
  const jobs = new JobManager()
  return {
    async syllabus(workspaceRoot, courseId) {
      const dir = await requireCourse(workspaceRoot, courseId)
      return loadSyllabus(dir)
    },
    async setGranularity(workspaceRoot, courseId, granularity) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const config = await getConfig()
      const generator = generatorOf({ workspaceRoot, config }, dir)
      if (generator === null) throw new Error('未配置模型端点')
      const builder = new CourseBuilder(dir, generator, inferrerOf({ workspaceRoot, config }))
      await builder.regenerateSyllabus(granularity)
      return loadSyllabus(dir)
    },
    async progress(workspaceRoot, courseId) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const board = await loadProgressBoard(join(dir, 'progress.md'))
      return {
        overallMastery: board.overallMastery,
        dueCount: board.dueCount,
        lastUpdatedAt: board.lastUpdatedAt,
        concepts: board.concepts.map(record => ({
          id: record.conceptId,
          name: record.name,
          chapter: record.chapter,
          mastery: record.mastery,
          evals: record.evals,
          passRate: record.passRate,
          ef: record.ef,
          nextReviewAt: record.nextReviewAt,
          misattribution: record.misattribution,
        })),
      }
    },
    async mastery(workspaceRoot, courseId) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const [board, currentSyllabus] = await Promise.all([loadProgressBoard(join(dir, 'progress.md')), loadSyllabus(dir)])
      const masteryByConcept = new Map(board.concepts.map(record => [record.conceptId, record.mastery]))
      const chapters = currentSyllabus.chapters.map(chapter => ({
        id: chapter.id,
        mastery: chapter.concepts.length > 0
          ? chapter.concepts.reduce((sum, concept) => sum + (masteryByConcept.get(concept.id) ?? 0), 0) / chapter.concepts.length
          : 0,
        concepts: chapter.concepts.map(concept => ({
          id: concept.id,
          mastery: masteryByConcept.get(concept.id) ?? 0,
          status: (masteryByConcept.get(concept.id) ?? 0) >= 0.7 ? 'mastered' : (masteryByConcept.get(concept.id) ?? 0) >= 0.4 ? 'weak' : 'learning',
        })),
      }))
      return { chapters }
    },
    async quiz(workspaceRoot, courseId, mode, count, conceptId, dueOnly) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const tasks = await pickTasks(dir, mode, conceptId, count, new Date().toISOString().slice(0, 10), dueOnly)
      return tasks.map(quizView)
    },
    async taskPool(workspaceRoot, courseId, conceptId, limit) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const tasks = await loadTaskPool(dir)
      const filtered = conceptId === null ? tasks : tasks.filter(task => task.concept_id === conceptId)
      return filtered.slice(0, Math.max(1, Math.min(100, limit))).map(task => ({
        taskId: task.task_id,
        conceptId: task.concept_id,
        type: task.type,
        difficulty: task.difficulty,
        ...(task.dynamic === undefined ? {} : { dynamic: task.dynamic }),
        ...(task.target_id === undefined ? {} : { targetId: task.target_id }),
      }))
    },
    async files(workspaceRoot, courseId) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const { courseSourceRoot } = await import('@studyclaw/tools')
      const root = await courseSourceRoot(dir)
      return enumerateFiles(root)
    },
    async workspaceFiles(workspaceRoot) {
      const files: Array<Record<string, unknown>> = []
      const collect = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(dir, entry.name)
          const rel = relative(workspaceRoot, path).split('\\').join('/')
          if (entry.name.startsWith('.')) continue
          if (entry.isDirectory()) {
            if (['.studyclaw', 'courses', 'node_modules', '.git', '.next', 'tasks', 'history'].includes(entry.name)) continue
            await collect(path, depth + 1)
          } else if (entry.isFile() && /\.(md|txt|pdf)$/i.test(entry.name) && !['syllabus.json', 'progress.md', 'notes.md', '.checksums', '.source-root.json'].includes(entry.name)) {
            const info = await stat(path)
            files.push({ name: entry.name, path, relative: rel, size: info.size, mtime: info.mtime.toISOString(), supported: true })
          }
        }
      }
      if ((await stat(workspaceRoot).catch(() => null))?.isDirectory()) await collect(workspaceRoot, 0)
      return { root: workspaceRoot, files: files.slice(0, 500) }
    },
    async sync(workspaceRoot, courseId, sessionId = null) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const config = await configForSession(workspaceRoot, courseId, sessionId, await getConfig())
      const generator = generatorOf({ workspaceRoot, config }, dir)
      if (generator === null) throw new Error('未配置模型端点（.studyclaw/config.yaml 缺少 llm 配置）')
      const builder = projectBuilder(dir, generator, inferrerOf({ workspaceRoot, config }))
      const before = await loadTaskPool(dir)
      const report: BuildReport = await builder.build(2)
      const after = await loadTaskPool(dir)
      return {
        added: report.added,
        changed: report.modified,
        skipped: report.unchanged.length,
        buildJobId: null,
        tasksGenerated: report.tasksGenerated,
        conceptsSeeded: report.conceptsSeeded,
        degraded: report.degraded,
        poolDelta: after.length - before.length,
      }
    },
    async ingestUrl(workspaceRoot, courseId, url, title) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const response = await fetch(url, { headers: { 'User-Agent': 'StudyClaw/0.1' } })
      if (!response.ok) throw new Error(`抓取失败: HTTP ${response.status}`)
      let html = await response.text()
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ''
      const titleText = (title ?? stripTags(heading)).trim() || url
      const text = stripTags(html).replace(/\n{3,}/g, '\n\n').slice(0, 200_000)
      const slugBase = createHash('md5').update(url, 'utf8').digest('hex').slice(0, 8)
      const sourcesDir = join(dir, 'sources')
      await mkdir(sourcesDir, { recursive: true })
      const path = join(sourcesDir, `web_${slugBase}.md`)
      await writeFile(path, `# ${titleText}\n\n> 来源：${url}\n\n${text}\n`, 'utf8')
      const config = await getConfig()
      const generator = generatorOf({ workspaceRoot, config }, dir)
      let buildJobId: string | null = null
      if (generator !== null) {
        buildJobId = jobs.start(dir, courseId, { workspaceRoot, config })
      }
      return { courseId, added: path, url, title: titleText, buildJobId }
    },
    async createCards(workspaceRoot, courseId, payload) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const config = await configForSession(workspaceRoot, courseId, payload.sessionId, await getConfig())
      if (config === null) throw new Error('未配置模型端点')
      const generator = generatorOf({ workspaceRoot, config }, dir)
      if (generator === null) throw new Error('未配置模型端点')
      const title = payload.title ?? payload.content.slice(0, 30)
      const conceptId = payload.conceptId ?? slugId(title)
      const chunk = {
        chunk_id: 'manual_001',
        chapter_id: 'chap_manual',
        concept_id: conceptId,
        title,
        content: payload.content,
        source_ref: { file: 'manual', chunk_id: 'manual_001' },
      }
      const tasks = await generator.generateTasks(chunk, payload.count ?? 1)
      const pool = await loadTaskPool(dir)
      await writeTaskPool(dir, [...pool, ...tasks])
      return { courseId, tasks }
    },
    async dynamicCards(workspaceRoot, courseId, payload) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const config = await configForSession(workspaceRoot, courseId, payload.sessionId, await getConfig())
      if (config === null) throw new Error('未配置模型端点')
      const pool = await loadTaskPool(dir)
      const source = pool.find(task => task.task_id === payload.taskId)
      if (source === undefined) throw new Error(`题卡不存在: ${payload.taskId}`)
      const cards = await generateDynamicCards(
        createDeepSeekToolClient(config),
        { model: config.model, provider: config.providerId || 'studyclaw', temperature: config.temperature },
        source,
        payload.misconception,
        payload.count ?? 1,
        payload.targetId ?? null,
      )
      await writeTaskPool(dir, [...pool, ...cards])
      return { courseId, tasks: cards }
    },
    async *evalSubmit(workspaceRoot, courseId, taskId, answer, sessionId = null) {
      const dir = await requireCourse(workspaceRoot, courseId)
      const config = await configForSession(workspaceRoot, courseId, sessionId, await getConfig())
      if (config === null) throw new Error('未配置模型端点')
      const pool = await loadTaskPool(dir)
      const task = pool.find(candidate => candidate.task_id === taskId)
      if (task === undefined) throw new Error(`题卡不存在: ${taskId}`)
      yield { event: 'scan', data: { phase: 'rubric' } }
      const evaluator = new RubricEvaluator(createDeepSeekToolClient(config), {
        model: config.model, provider: config.providerId || 'studyclaw', temperature: config.temperature,
      })
      const memory = await readGlobalMemory(workspaceRoot)
      const result = await evaluator.evaluate(task, answer, memory.slice(0, 2000))
      for (const [criterion, hit] of Object.entries(result.rubricHits)) {
        yield { event: 'rubric', data: { index: 0, criterion, hit } }
      }
      // Update the task history + progress board (SM-2).
      const board = await loadProgressBoard(join(dir, 'progress.md'))
      const record = board.concepts.find(candidate => candidate.conceptId === task.concept_id)
      const attempts = (record?.evals ?? 0) + 1
      const passRate = record !== undefined
        ? (record.passRate * record.evals + (result.passed ? 1 : 0)) / attempts
        : (result.passed ? 1 : 0)
      const next = reviewSchedule(record?.ef ?? 2.5, attempts, result.score)
      const nextReviewAt = new Date(Date.now() + next.intervalDays * 86_400_000).toISOString().slice(0, 10)
      const updated = upsertProgressRecord(board, {
        conceptId: task.concept_id,
        name: record?.name ?? task.concept_id,
        chapter: record?.chapter ?? '',
        mastery: result.passed ? Math.max(record?.mastery ?? 0, result.score) : Math.min(record?.mastery ?? 0, result.score * 0.9),
        evals: attempts,
        passRate,
        ef: next.ef,
        nextReviewAt,
        misattribution: result.misconceptions.length > 0 ? '概念混淆' : 'none',
      })
      await saveProgressBoard(join(dir, 'progress.md'), updated)
      // Append the eval audit line into the latest session history (Python
      // parity): heatmap metrics are computed from these rows.
      const store = new SessionStore(join(dir, 'history'))
      let auditSessionId = sessionId ?? await store.latestSessionId()
      if (auditSessionId === null) auditSessionId = (await store.newSession('socratic')).sessionId
      await store.append(auditSessionId, {
        type: 'eval',
        ts: utcTs(),
        task_id: taskId,
        concept_id: task.concept_id,
        score: result.score,
        passed: result.passed,
        rubric_hits: result.rubricHits,
        misconceptions: result.misconceptions,
      } as never)
      yield { event: 'result', data: { score: result.score, passed: result.passed, feedback: result.feedback, misconceptions: result.misconceptions } }
      yield { event: 'sm2', data: { ef: next.ef, efNew: next.ef, nextReviewAt, masteryDelta: result.passed ? 0.1 : -0.1 } }
      yield { event: 'done', data: { taskId } }
    },
    job(jobId) {
      return jobs.get(jobId)
    },
    tools(providerStatus = {}) {
      return [...buildDefaultSpecs(), ...buildGenericSpecs()].map(spec => ({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        policy: spec.policy,
        timeout: spec.timeout,
        execution: spec.execution,
        renderIntent: spec.renderIntent,
        retry: spec.retry,
        requiresApproval: spec.requiresApproval,
        ...(spec.provider === undefined ? {} : {
          provider: spec.provider,
          providerStatus: providerStatus[spec.provider] ?? {
            available: false,
            reason: `Provider ${spec.provider} 未安装或未启用`,
            installAction: `配置 ${spec.provider} Provider`,
          },
        }),
      }))
    },
    heatmap: (workspaceRoot, weeks) => heatmap(workspaceRoot, weeks) as unknown as Promise<Record<string, unknown>>,
    heatmapDay: (workspaceRoot, date) => heatmapDay(workspaceRoot, date) as unknown as Promise<Record<string, unknown>>,
    buildJob: () => null,
    async createCourse(workspaceRoot, _courseName, importPaths) {
      // 项目即课程：材料直接落到项目根（就地），随后构建大纲（无 LLM 配置时
      // 生成器空转，骨架仍会产出，保证“打开即初始化”）。
      const dir = workspaceRoot
      let ingested = 0
      const { copyFile } = await import('node:fs/promises')
      for (const source of importPaths.slice(0, 200)) {
        const info = await stat(source).catch(() => null)
        if (info === null || !info.isFile()) continue
        // Windows absolute paths use backslashes; splitting only on "/" would
        // keep the whole path as the file name and make the copy target invalid.
        const name = source.split(/[\\/]/).pop() ?? 'import.txt'
        const copied = await copyFile(source, join(dir, name)).then(() => true).catch(() => false)
        if (copied) ingested += 1
      }
      const config = await getConfig()
      const generator = generatorOf({ workspaceRoot, config }, dir) ?? { generateTasks: async () => [] }
      // 空项目/未初始化项目：build 无变更不会产出 syllabus，先落骨架保证
      // "打开即初始化"（列表判定以 syllabus.json 存在为准）。
      const syllabusPath = join(dir, 'syllabus.json')
      if ((await stat(syllabusPath).catch(() => null)) === null) {
        await writeFile(syllabusPath, JSON.stringify({
          course_id: basename(workspaceRoot), title: _courseName || basename(workspaceRoot), version: '1.0.0',
          granularity: 'fine', chapters: [], adjacency: {},
        }, null, 2) + '\n', 'utf8')
      }
      await projectBuilder(dir, generator, inferrerOf({ workspaceRoot, config })).build(2)
      return { workspace: workspaceRoot, course: basename(workspaceRoot), ingestedFiles: ingested, buildJobId: null }
    },
  }
}

async function enumerateFiles(root: string): Promise<{ root: string; files: Array<Record<string, unknown>> }> {
  const files: Array<Record<string, unknown>> = []
  const collect = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await collect(path)
      } else if (entry.isFile() && /\.(md|txt|pdf)$/i.test(entry.name)) {
        const info = await stat(path)
        files.push({ name: entry.name, path, relative: relative(root, path).split('\\').join('/'), size: info.size, mtime: info.mtime.toISOString(), supported: true })
      }
    }
  }
  if ((await stat(root).catch(() => null))?.isDirectory()) await collect(root)
  return { root, files: files.slice(0, 500) }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function slugId(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
  return `c_${base !== '' ? base : createHash('md5').update(title).digest('hex').slice(0, 8)}`
}

export { createUserMessage }
export type { GenerateOptions }
