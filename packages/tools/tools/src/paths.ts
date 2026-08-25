/**
 * Course path facts for the tools layer: the source-root canon (`.source-root.json`
 * binding for in-place courses, the project root otherwise) and the in-place
 * exclusion set. Ported from Python `workspace.py`; project-folder-as-course
 * layout makes every course "in place".
 * @module @studyclaw/tools/src/paths
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ToolRejected } from './result.ts'

export const SOURCE_ROOT_BINDING_NAME = '.source-root.json'

/** Courses must not scan these as study material (Python parity, plus the
 *  project-folder-as-course state directories). */
export const INPLACE_SOURCE_EXCLUDED_DIRS = new Set([
  '.git',
  '.studyclaw',
  'courses',
  'node_modules',
  '__pycache__',
  '.next',
  '.venv',
  'venv',
  'tasks',
  'history',
])

/** State file names skipped by material scans (value mirrors
 *  `@studyclaw/course-builder`'s COURSE_STATE_FILES; kept local to avoid a
 *  dependency cycle — tools ↔ builder). */
export const SOURCE_EXCLUDED_FILES = new Set([
  'syllabus.json',
  'progress.md',
  'notes.md',
  '.checksums',
  '.source-root.json',
])

/**
 * The course's actual material root: the `.source-root.json` binding for
 * in-place courses, the project root otherwise.
 * @param courseDir - Course (project root) directory.
 * @returns the resolved material root.
 */
export async function courseSourceRoot(courseDir: string): Promise<string> {
  const binding = join(courseDir, SOURCE_ROOT_BINDING_NAME)
  try {
    const data = JSON.parse(await readFile(binding, 'utf8')) as { path?: unknown }
    const raw = data?.path
    if (typeof raw === 'string' && raw !== '') {
      const target = resolve(courseDir, raw)
      return target
    }
  } catch {
    // No binding / unreadable: fall through to the canonical project root.
  }
  return courseDir
}

/** Whether the course uses its original project directory as the material root. */
export async function isInplaceCourse(courseDir: string): Promise<boolean> {
  return (await stat(join(courseDir, SOURCE_ROOT_BINDING_NAME)).catch(() => null))?.isFile() ?? false
}

/**
 * Resolve a model-supplied relative path safely inside the source root:
 * absolute paths, `..`, hidden segments, and excluded dirs are rejected.
 * @param courseDir - Course directory.
 * @param ref - Relative path in any spelling.
 * @returns the resolved absolute path.
 */
export async function resolveSourceRef(courseDir: string, ref: string): Promise<string> {
  const root = resolve(await courseSourceRoot(courseDir))
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ToolRejected('课程资料根目录不存在（先运行 studyclaw build）')
  }
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new ToolRejected('path 不能为空')
  }
  const normalized = ref.trim().replaceAll('\\', '/')
  if (/^([a-zA-Z]:)?\//.test(normalized)) {
    throw new ToolRejected('path 必须是课程资料根目录下的相对路径')
  }
  const parts = normalized.split('/').filter(part => part !== '')
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new ToolRejected(`非法的 path: ${ref}`)
  }
  const excluded = (await isInplaceCourse(courseDir)) ? INPLACE_SOURCE_EXCLUDED_DIRS : new Set<string>()
  if (parts.some(part => part.startsWith('.') || excluded.has(part))) {
    throw new ToolRejected('不允许访问隐藏文件/目录或课程内部状态目录')
  }
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root.endsWith('\\') ? root : root + '\\')) {
    throw new ToolRejected('path 超出课程资料根目录')
  }
  return target
}
