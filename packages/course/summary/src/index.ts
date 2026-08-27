/**
 * Read-only course listing for "project folder = one course" layout: a
 * project root is a course when it already holds `syllabus.json`; otherwise
 * the project is uninitialized (`courses: []`, `missing: false`) so callers
 * can offer to initialize it in place. Every read is best-effort: a corrupt
 * syllabus or missing progress.md never throws, it falls back to the folder
 * name and zero metrics.
 * @module @studyclaw/course-summary
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'

/** One course row in the project sidebar tree (wire shape matches Python). */
export interface CourseSummary {
  readonly id: string
  readonly title: string
  readonly overallMastery: number
  readonly dueToday: number
  readonly lastActiveAt: string | null
}

/**
 * Durable syllabus.json shape (Python schemas.Syllabus); only the fields the
 * listing reads are declared, the rest are ignored.
 */
const syllabusSchema = z.object({
  course_id: z.string(),
  title: z.string(),
})

/**
 * progress.md meta lines (Python progress.py `_META_*_RE`); the markdown
 * table body is ignored by the listing.
 */
const MASTERY_RE = /-\s*\*\*总体掌握度\*\*[:：]\s*([\d.]+)%/
const DUE_RE = /-\s*\*\*待复习卡片数\*\*[:：]\s*(\d+)/

function parseProgressMeta(text: string): { overallMastery: number; dueToday: number } {
  const mastery = MASTERY_RE.exec(text)
  const due = DUE_RE.exec(text)
  return {
    overallMastery: mastery === null ? 0 : Math.min(1, Number(mastery[1]) / 100),
    dueToday: due === null ? 0 : Number(due[1]),
  }
}

/**
 * Summaries for the "project folder = one course" model: at most a single
 * course (the project root itself). Uninitialized projects (no syllabus.json)
 * report an empty list so the caller can trigger in-place initialization.
 * @param root - Project (course folder) canonical directory.
 * @returns a single-element course list, or `{ missing: true }` when the
 * project directory no longer exists.
 */
export async function listCourseSummaries(
  root: string,
): Promise<{ courses: CourseSummary[]; missing: boolean }> {
  const rootStat = await stat(root).catch(() => null)
  if (rootStat === null || !rootStat.isDirectory()) return { courses: [], missing: true }

  const id = basename(root)
  // 应用产物自 v2 起收在 .studyclaw/ 下（与 builder/chat-service 同一约定）。
  const stateDir = join(root, '.studyclaw')
  const syllabus = await readFile(join(stateDir, 'syllabus.json'), 'utf8').catch(() => null)
  if (syllabus === null) return { courses: [], missing: false }

  let title = id
  try {
    title = syllabusSchema.parse(JSON.parse(syllabus)).title
  } catch {
    // Corrupt syllabus falls back to the folder name.
  }

  let overallMastery = 0
  let dueToday = 0
  const progress = await readFile(join(stateDir, 'progress.md'), 'utf8').catch(() => null)
  if (progress !== null) {
    ({ overallMastery, dueToday } = parseProgressMeta(progress))
  }

  let lastActiveAt: string | null = null
  const historyDir = join(stateDir, 'history')
  const history = await stat(historyDir).catch(() => null)
  if (history?.isDirectory()) {
    let newest = 0
    const { readdir } = await import('node:fs/promises')
    for (const file of await readdir(historyDir)) {
      if (!file.endsWith('.jsonl')) continue
      const mtime = await stat(join(historyDir, file)).then(info => info.mtimeMs).catch(() => 0)
      if (mtime > newest) newest = mtime
    }
    lastActiveAt = newest === 0 ? null : new Date(newest).toISOString()
  }

  return { courses: [{ id, title, overallMastery, dueToday, lastActiveAt }], missing: false }
}
