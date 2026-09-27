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

describe('RV-16：courses.files 枚举排除目录与数量上限', () => {
  it('node_modules/.git 等被排除，真实资料仍枚举（就地课程根即项目根）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-files-exclude-'))
    try {
      // 隔离注册表 home，避免测试污染真实用户目录。
      process.env.STUDYCLAW_HOME = join(root, 'home')
      const ws = join(root, 'ws')
      await mkdir(join(ws, 'docs'), { recursive: true })
      await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(join(ws, '.git'), { recursive: true })
      await writeFile(join(ws, 'overview.md'), '# 总览', 'utf8')
      await writeFile(join(ws, 'docs', 'note.md'), '# 笔记', 'utf8')
      await writeFile(join(ws, 'node_modules', 'pkg', 'readme.md'), '# pkg', 'utf8')
      await writeFile(join(ws, '.git', 'config.md'), '# git', 'utf8')
      const service = createCourseService(async () => null)
      const created = await service.createCourse(ws, '枚举测试', [])
      const result = await service.files(ws, created.course) as { files: Array<{ relative: string }> }
      expect(result.files.map(file => file.relative).sort()).toEqual(['docs/note.md', 'overview.md'])
    } finally {
      delete process.env.STUDYCLAW_HOME
      await rm(root, { recursive: true, force: true })
    }
  })

  it('文件数超过 500 时截断，且排除目录不计入（旧实现全量 walk 后 slice，瞬态内存无界）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-files-cap-'))
    try {
      process.env.STUDYCLAW_HOME = join(root, 'home')
      const ws = join(root, 'ws')
      await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
      for (let i = 0; i < 60; i += 1) {
        await writeFile(join(ws, 'node_modules', 'pkg', `mod-${i}.md`), '# pkg', 'utf8')
      }
      for (let i = 0; i < 505; i += 1) {
        await writeFile(join(ws, `doc-${String(i).padStart(3, '0')}.md`), '# doc', 'utf8')
      }
      const service = createCourseService(async () => null)
      const created = await service.createCourse(ws, '上限测试', [])
      const result = await service.files(ws, created.course) as { files: Array<{ relative: string }> }
      expect(result.files).toHaveLength(500)
      expect(result.files.every(file => !file.relative.startsWith('node_modules/'))).toBe(true)
    } finally {
      delete process.env.STUDYCLAW_HOME
      await rm(root, { recursive: true, force: true })
    }
  })
})
