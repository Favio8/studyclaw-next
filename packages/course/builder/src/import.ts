/**
 * M3 课程导入（还原备份）。
 *
 * 三条硬约束，来自「用户的数据不可再生」：
 * 1. 目标已存在时**默认拒绝**——绝不覆盖已有学习数据；
 * 2. 版本未知时**拒绝**并给出可读错误，不做尽力而为的部分恢复；
 * 3. 中途失败**整体回滚**，不在目标目录留半成品。
 * @module @studyclaw/course-builder/src/import
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readZip } from './zip.ts'
import { EXPORT_FORMAT_VERSION } from './export.ts'
import { renameWithRetry } from '@studyclaw/fs-atomic'
import { annotationsFile, harnessTask, syllabus } from './models.ts'

const MANIFEST_NAME = 'studyclaw-export.json'

export class ImportError extends Error {
  constructor(readonly code: 'invalid-archive' | 'unsupported-version' | 'target-exists' | 'unsafe-path', message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

export interface ImportResult {
  readonly courseId: string
  readonly files: number
}

/** 归档内路径安全：不得绝对路径、不得 `..` 穿越、不得 Windows 盘符。 */
function assertSafePath(path: string): void {
  const normalized = path.split('\\').join('/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new ImportError('unsafe-path', `归档包含越界路径，已拒绝：${path}`)
  }
}

/**
 * 把备份归档还原到 `targetRoot/<courseId>`。
 *
 * 流程：校验 manifest → 目标存在性检查 → 写进同级临时目录 → 逐个文件落盘 →
 * 原始状态字节写入 → rename 就位。安装失败时恢复旧目录并清掉临时目录。
 */
export async function importCourseBackup(
  archive: Buffer,
  targetRoot: string,
  options: { force?: boolean; courseIdOverride?: string } = {},
): Promise<ImportResult> {
  let entries
  try {
    entries = readZip(archive)
  } catch (error) {
    throw new ImportError('invalid-archive', `备份文件无法解析：${error instanceof Error ? error.message : String(error)}`)
  }

  const manifestEntry = entries.find(entry => entry.path === MANIFEST_NAME)
  if (manifestEntry === undefined) {
    throw new ImportError('invalid-archive', '备份缺少 studyclaw-export.json 清单，不是 StudyClaw 备份')
  }
  let manifest: { studyclaw_export?: unknown; course_id?: unknown }
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as typeof manifest
  } catch {
    throw new ImportError('invalid-archive', '备份清单不是合法 JSON')
  }
  if (manifest.studyclaw_export !== EXPORT_FORMAT_VERSION) {
    throw new ImportError('unsupported-version',
      `备份版本不受支持（${String(manifest.studyclaw_export)}，当前支持 ${EXPORT_FORMAT_VERSION}）：请升级 StudyClaw 后重试`)
  }
  // 显式改名覆盖优先于归档自带的 id；两者都没有才算清单缺失。
  const override = options.courseIdOverride
  const courseId = override !== undefined && override !== ''
    ? override
    : (typeof manifest.course_id === 'string' ? manifest.course_id : '')
  if (courseId === '') throw new ImportError('invalid-archive', '备份清单缺少 course_id')
  // 目录名直接由归档内容（外部文件）决定，必须过路径守卫。
  if (/[\\/]/.test(courseId) || courseId.includes('..') || courseId === '.' || courseId.startsWith('.')) {
    throw new ImportError('unsafe-path', `备份中的 course_id 不是合法目录名：${courseId}`)
  }

  const targetDir = join(targetRoot, courseId)
  if (options.force !== true) {
    const { stat } = await import('node:fs/promises')
    const exists = await stat(targetDir).catch(() => null)
    if (exists !== null) {
      throw new ImportError('target-exists',
        `目标「${courseId}」已存在：已拒绝导入以免覆盖现有学习数据。请换一个 --course-id，或确认后使用 --force。`)
    }
  }

  for (const entry of entries) {
    assertSafePath(entry.path)
    const path = posix.normalize(entry.path.replaceAll('\\', '/'))
    const schema = path === '.studyclaw/syllabus.json' ? syllabus
      : path === '.studyclaw/annotations.json' ? annotationsFile
        : /^\.studyclaw\/tasks\/task_\d+\.json$/.test(path) ? harnessTask : null
    if (schema !== null) {
      let data: unknown
      try { data = JSON.parse(entry.data.toString('utf8')) } catch {
        throw new ImportError('invalid-archive', `备份中的 ${path} 不是合法 JSON`)
      }
      if (!schema.safeParse(data).success) throw new ImportError('invalid-archive', `备份中的 ${path} 结构无效`)
    }
  }

  // 暂存目录必须建在 **targetRoot 之内**（同一卷），最后才能靠 rename 原子就位。
  // 用系统 tmpdir 会跨盘 —— 工作区在 D:、TEMP 在 C: 时 rename 直接抛 EXDEV，
  // 导入对所有真实用户都会失败（实测）。目标根可能尚未存在，先确保它存在。
  await mkdir(targetRoot, { recursive: true })
  const staging = join(targetRoot, `.studyclaw-import-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`)
  await mkdir(staging, { recursive: true })
  const retired = `${targetDir}.studyclaw-import-old-${randomUUID().slice(0, 8)}`
  let movedOld = false
  try {
    for (const entry of entries) {
      const path = join(staging, entry.path)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, entry.data)
    }
    // force 时先把旧目标**改名让位**（而不是先删）：万一最终 rename 失败，
    // 用户的旧数据仍然完好躺在 retired 里，不会出现"删了又没装上"的空窗。
    if (options.force === true && await exists(targetDir)) {
      await renameWithRetry(targetDir, retired)
      movedOld = true
    }
    await renameWithRetry(staging, targetDir)
    if (options.force === true) await rm(retired, { recursive: true, force: true }).catch(() => undefined)
  } catch (error) {
    if (movedOld) {
      try { await renameWithRetry(retired, targetDir) } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `导入及回滚失败，原数据保留在：${retired}`)
      }
    }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  return { courseId, files: entries.length }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null
}
