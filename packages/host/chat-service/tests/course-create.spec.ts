/**
 * createCourse archive regression: Windows backslash import paths must be
 * split into real file names (not kept as a whole path) and ingestedFiles
 * must only count successful copies.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCourseService } from '../src/course.ts'

describe('createCourse source archiving', () => {
  it('archives a workspace file given as an absolute backslash path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-create-course-'))
    try {
      const ws = join(root, 'ws')
      await mkdir(ws, { recursive: true })
      const sourcePath = join(root, 'java-basics.md')
      await writeFile(sourcePath, '# 覆写与重载\n\n内容。', 'utf8')
      const service = createCourseService(async () => null)
      const result = await service.createCourse(ws, 'Java OOP', [sourcePath])
      expect(result.ingestedFiles).toBe(1)
      // 项目即课程：导入文件直接落到项目根（就地），不再进入 sources/ 子目录。
      const rootFiles = await readdir(ws)
      expect(rootFiles).toContain('java-basics.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not count missing files as ingested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-create-course-'))
    try {
      const ws = join(root, 'ws')
      await mkdir(ws, { recursive: true })
      const service = createCourseService(async () => null)
      const ghost = join(ws, 'ghost.md')
      const result = await service.createCourse(ws, 'empty-course', [ghost])
      expect(result.ingestedFiles).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
