/**
 * M3 课程导出：把「文件即状态」兑现成用户可自己拿走的产物。
 *
 * 两种格式，各有明确用途：
 * - `markdown` — **人读**。单文件、可全文检索、可直接投喂 Obsidian/Logseq、
 *   可邮件传输。迁移首选。
 * - `backup`（zip） — **还原**。完整状态文件按原相对路径归档，供 import 还原。
 *
 * 安全边界：只读**白名单**里的状态文件。`config.yaml`、`credentials/`、
 * `secret-box` 主密钥一律不碰——导出物会流转到用户随手的位置。
 * 绝不能用"把对象整个序列化"的写法，那会把凭据一起带出去。
 * @module @studyclaw/course-builder/src/export
 */

import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { loadProgressBoard, renderMastery, type ProgressBoard } from './progress.ts'
import { stateDirOf } from './builder.ts'
import { annotationsFile, syllabus as syllabusSchema, harnessTask as harnessTaskSchema, type HarnessTask, type Syllabus } from './models.ts'
import { createZip, type ZipEntry } from './zip.ts'

/** 导出物格式版本。未知版本一律拒绝导入，不做尽力而为的部分恢复。 */
export const EXPORT_FORMAT_VERSION = 1

/** 备份归档里允许出现的状态文件（相对 `.studyclaw/`）。白名单，不是黑名单。 */
const BACKUP_FILES = ['syllabus.json', 'progress.md', 'notes.md', 'annotations.json'] as const
const BACKUP_DIRS = ['tasks', 'history'] as const

/** Only absence is optional. Failed reads must never produce a "complete" backup. */
function optionalFile<T>(read: Promise<T>): Promise<T | null> {
  return read.catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function assertNoLinks(courseDir: string, path: string): Promise<void> {
  let current = courseDir
  for (const part of relative(courseDir, path).split(sep)) {
    current = join(current, part)
    const info = await optionalFile(lstat(current))
    if (info === null) return
    if (info.isSymbolicLink()) throw new Error(`导出路径不允许是符号链接：${current}`)
  }
}

async function readState(courseDir: string, path: string): Promise<Buffer | null> {
  await assertNoLinks(courseDir, path)
  return optionalFile(readFile(path))
}

async function stateNames(courseDir: string, path: string): Promise<string[]> {
  await assertNoLinks(courseDir, path)
  return (await optionalFile(readdir(path)) ?? []).sort()
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return null }
}


/** 凭据类文件：出现在备份里就是事故，显式列出以便测试钉死。 */
export const NEVER_EXPORTED = ['config.yaml', 'credentials', 'secret-box', 'master.key', 'apiKey', 'token'] as const

export interface CourseExportData {
  readonly courseId: string
  readonly syllabus: Syllabus | null
  readonly board: ProgressBoard
  readonly tasks: readonly HarnessTask[]
  readonly notes: string
  readonly annotations: string
}

/** 缺失或 JSON 损坏可降级渲染；实际 I/O 失败直接报告，避免静默漏数据。 */
export async function loadCourseExportData(courseDir: string, courseId: string): Promise<CourseExportData> {
  const stateDir = stateDirOf(courseDir)
  const syllabusRaw = await readState(courseDir, join(stateDir, 'syllabus.json'))
  let syllabus: Syllabus | null = null
  if (syllabusRaw !== null) {
    const parsed = syllabusSchema.safeParse(parseJson(syllabusRaw.toString('utf8')))
    if (parsed.success) syllabus = parsed.data
  }
  const tasks: HarnessTask[] = []
  const tasksDir = join(stateDir, 'tasks')
  for (const name of await stateNames(courseDir, tasksDir)) {
    if (!/^task_\d+\.json$/.test(name)) continue
    const raw = await readState(courseDir, join(tasksDir, name))
    if (raw === null) continue
    const parsed = harnessTaskSchema.safeParse(parseJson(raw.toString('utf8')))
    // 结构不合法的卡片跳过而不是让整次导出失败——导出是用户最后的退路。
    if (parsed.success) tasks.push(parsed.data)
  }
  await assertNoLinks(courseDir, join(stateDir, 'progress.md'))
  return {
    courseId,
    syllabus,
    board: await loadProgressBoard(join(stateDir, 'progress.md')),
    tasks,
    notes: (await readState(courseDir, join(stateDir, 'notes.md')))?.toString('utf8') ?? '',
    annotations: (await readState(courseDir, join(stateDir, 'annotations.json')))?.toString('utf8') ?? '',
  }
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ')
}

function answerOf(task: HarnessTask): string {
  if (task.options !== null && task.options.length > 0 && task.answer_index !== null) {
    return task.options[task.answer_index] ?? ''
  }
  return task.answer_rationale ?? '（主观题，见评分标准）'
}

function renderProgress(board: ProgressBoard): string {
  if (board.concepts.length === 0) return '_暂无进度记录。_\n'
  const rows = board.concepts.map(record => `| ${cell(record.conceptId)} | ${cell(record.name)} | ${cell(record.chapter)} | ${renderMastery(record.mastery)} | ${record.evals} | ${Math.round(record.passRate * 100)}% | ${record.ef.toFixed(2)} | ${record.nextReviewAt ?? '-'} | ${record.streak} | ${record.exposure} |`)
  return [
    '| 概念 ID | 概念 | 章节 | 掌握度 | 评测 | 正确率 | EF | 下次复习 | 连续答对 | 阅读接触 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

function renderSyllabus(syllabus: Syllabus | null): string {
  if (syllabus === null) return '_暂无大纲（课程尚未构建）。_\n'
  const out: string[] = []
  for (const chapter of syllabus.chapters) {
    out.push(`### ${chapter.title}`)
    if (chapter.description !== '') out.push(`> ${chapter.description}`)
    for (const concept of chapter.concepts) out.push(`- **${concept.name}**（${concept.type}）`)
    out.push('')
  }
  return out.join('\n')
}

function renderTasks(tasks: readonly HarnessTask[]): string {
  if (tasks.length === 0) return '_暂无题卡。_\n'
  const out: string[] = []
  for (const task of tasks) {
    out.push(`### [${cell(task.concept_id)}] ${task.question}`)
    out.push(`- 难度：${task.difficulty}/5　类型：${task.type}　状态：${task.deprecated ? '已废弃' : '有效'}`)
    if (task.source_ref !== null) out.push(`- 来源：${task.source_ref.file}`)
    if (task.options !== null && task.options.length > 0) {
      task.options.forEach((option, index) => { out.push(`  - ${String.fromCharCode(65 + index)}. ${option}`) })
    }
    out.push(`- 正确答案：${answerOf(task)}`)
    for (const rubric of task.evaluation_criteria.rubric) out.push(`- 采分点：${rubric}`)
    out.push('')
  }
  return out.join('\n')
}

function renderAnnotations(raw: string): string {
  if (raw.trim() === '') return '_暂无阅读标注。_\n'
  const parsed = annotationsFile.safeParse(parseJson(raw))
  if (!parsed.success) {
    return '_标注文件损坏，未能解析。_\n'
  }
  const out: string[] = []
  for (const [source, entry] of Object.entries(parsed.data.sources)) {
    const highlights = entry.highlights ?? []
    if (highlights.length === 0) continue
    out.push(`### ${source}`)
    for (const highlight of highlights) {
      const suffix = highlight.tags.length > 0 ? `（标签：${highlight.tags.join('、')}）` : ''
      const comment = highlight.comment !== '' ? `　批注：${highlight.comment}` : ''
      out.push(`- [p.${highlight.page}] ${highlight.quote.text}${suffix}${comment}`)
    }
    out.push('')
  }
  return out.length === 0 ? '_暂无阅读标注。_\n' : out.join('\n')
}

/** 渲染单文件 Markdown 导出。计数写在 frontmatter，便于人工核对完整性。 */
export function renderCourseMarkdown(data: CourseExportData, exportedAt = new Date()): string {
  const title = data.syllabus?.title ?? data.courseId
  const annotationCount = (() => {
    try {
      const parsed = JSON.parse(data.annotations) as { sources?: Record<string, { highlights?: unknown[] }> }
      return Object.values(parsed.sources ?? {}).reduce((sum, entry) => sum + (entry.highlights?.length ?? 0), 0)
    } catch {
      return 0
    }
  })()
  return [
    '---',
    `studyclaw_export: ${EXPORT_FORMAT_VERSION}`,
    `course_id: ${data.courseId}`,
    `course_title: ${title}`,
    `exported_at: ${exportedAt.toISOString()}`,
    `concept_count: ${data.board.concepts.length}`,
    `task_count: ${data.tasks.length}`,
    `annotation_count: ${annotationCount}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## 学习进度',
    renderProgress(data.board),
    '## 大纲',
    renderSyllabus(data.syllabus),
    '## 题卡',
    renderTasks(data.tasks),
    '## 阅读标注',
    renderAnnotations(data.annotations),
    '## 笔记',
    data.notes.trim() === '' ? '_暂无笔记。_\n' : data.notes,
  ].join('\n')
}

/**
 * 收集完整备份条目：白名单状态文件 + `tasks/`、`history/`。
 * 缺失条目省略，已有文件按原始字节保留；I/O 失败直接报告。只读取白名单。
 */
export async function collectBackupEntries(courseDir: string, manifest: string): Promise<ZipEntry[]> {
  const stateDir = stateDirOf(courseDir)
  // 归档内保留 `.studyclaw/` 前缀，导入才能还原出**原始布局**——否则还原出来
  // 的是把状态文件铺在课程根的旧 v1 布局，builder/reading 全都找不到它们。
  const entries: ZipEntry[] = [{ path: 'studyclaw-export.json', data: Buffer.from(manifest, 'utf8') }]
  for (const name of BACKUP_FILES) {
    const data = await readState(courseDir, join(stateDir, name))
    if (data !== null) entries.push({ path: `.studyclaw/${name}`, data })
  }
  for (const dir of BACKUP_DIRS) {
    const base = join(stateDir, dir)
    for (const name of await stateNames(courseDir, base)) {
      if (dir === 'tasks' ? !/^task_\d+\.json$/.test(name) : !name.endsWith('.jsonl')) continue
      const data = await readState(courseDir, join(base, name))
      if (data !== null) entries.push({ path: `.studyclaw/${dir}/${name}`, data })
    }
  }
  return entries
}

/** 打包完整备份（供 import 还原）。 */
export async function createCourseBackup(courseDir: string, exportedAt = new Date()): Promise<Buffer> {
  const courseId = courseDir.split(/[\\/]/).filter(Boolean).pop() ?? 'course'
  const data = await loadCourseExportData(courseDir, courseId)
  const manifest = JSON.stringify({
    studyclaw_export: EXPORT_FORMAT_VERSION,
    course_id: courseId,
    course_title: data.syllabus?.title ?? courseId,
    exported_at: exportedAt.toISOString(),
    task_count: data.tasks.length,
    concept_count: data.board.concepts.length,
  }, null, 2)
  return createZip(await collectBackupEntries(courseDir, manifest))
}
