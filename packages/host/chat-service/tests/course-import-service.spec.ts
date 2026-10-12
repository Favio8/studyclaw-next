/**
 * M3 导入的服务层回归。
 *
 * 这层曾被真实缺陷穿透：`importCourse` 早先调用 `requireCourse` 解析目标，
 * 而 `requireCourse` 要求课程目录**已存在**——换机还原（这里还没有这门课）
 * 必然抛 CourseNotFoundError。CLI 用例把 RPC 打了桩，没能暴露它。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCourseBackup } from '@studyclaw/course-builder'
import { createCourseService } from '../src/course.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function backupOf(): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-importsvc-'))
  tmpRoots.push(root)
  const src = join(root, '机器学习')
  await mkdir(join(src, '.studyclaw'), { recursive: true })
  await writeFile(join(src, '.studyclaw', 'progress.md'), '# 学习进度\n', 'utf8')
  return createCourseBackup(src)
}

describe('courseService.importCourse', () => {
  it('课程目录尚不存在时也能还原（换机场景）', async () => {
    const service = createCourseService(async () => null)
    const ws = join(await mkdtemp(join(tmpdir(), 'studyclaw-fresh-')), '机器学习')
    tmpRoots.push(ws)
    await mkdir(ws, { recursive: true })

    const result = await service.importCourse(ws, '', (await backupOf()).toString('base64'), false)
    expect(result.courseId).toBe('机器学习')
    expect(await readFile(join(ws, '机器学习', '.studyclaw', 'progress.md'), 'utf8')).toContain('学习进度')
  })

  it('--course-id 作为改名覆盖生效（而不是被 requireCourse 拒绝）', async () => {
    const service = createCourseService(async () => null)
    const ws = join(await mkdtemp(join(tmpdir(), 'studyclaw-rename-')), '机器学习')
    tmpRoots.push(ws)
    await mkdir(ws, { recursive: true })

    const result = await service.importCourse(ws, '期末复习', (await backupOf()).toString('base64'), false)
    expect(result.courseId).toBe('期末复习')
    expect(await readFile(join(ws, '期末复习', '.studyclaw', 'progress.md'), 'utf8')).toContain('学习进度')
  })

  it('改名覆盖同样受路径守卫约束', async () => {
    const service = createCourseService(async () => null)
    const ws = join(await mkdtemp(join(tmpdir(), 'studyclaw-evil-')), '机器学习')
    tmpRoots.push(ws)
    await mkdir(ws, { recursive: true })

    await expect(service.importCourse(ws, '../逃逸', (await backupOf()).toString('base64'), false))
      .rejects.toThrow(/不是合法目录名/)
  })

  it('同名已存在时默认拒绝，不覆盖', async () => {
    const service = createCourseService(async () => null)
    const ws = join(await mkdtemp(join(tmpdir(), 'studyclaw-exists-')), '机器学习')
    tmpRoots.push(ws)
    await mkdir(join(ws, '机器学习', '.studyclaw'), { recursive: true })
    await writeFile(join(ws, '机器学习', '.studyclaw', 'progress.md'), '我自己的数据', 'utf8')

    await expect(service.importCourse(ws, '', (await backupOf()).toString('base64'), false))
      .rejects.toThrow(/已存在/)
    expect(await readFile(join(ws, '机器学习', '.studyclaw', 'progress.md'), 'utf8')).toBe('我自己的数据')
  })
})
