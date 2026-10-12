import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ deniedSuffix: '' }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (path: unknown, ...args: unknown[]) => {
    if (fault.deniedSuffix && String(path).endsWith(fault.deniedSuffix)) return Promise.reject(Object.assign(new Error('INJECTED ACCESS DENIED'), { code: 'EACCES' }))
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...args)
  } }
})
import { loadSyllabus } from '../src/builder.ts'
import { loadProgressBoard, saveProgressBoard } from '../src/progress.ts'
import { SyncApplier } from '@studyclaw/session'

const roots: string[] = []
afterEach(async () => { fault.deniedSuffix = ''; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('大纲/进度的读取失败不能重置学生状态', () => {
  it.each(['syllabus', 'load-progress', 'save-progress', 'sync'])('%s 传播 I/O 错误，保留原文件', async operation => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-course-io-'))
    roots.push(root)
    await mkdir(join(root, '.studyclaw'))
    const path = join(root, '.studyclaw', operation === 'syllabus' ? 'syllabus.json' : 'progress.md')
    const raw = 'ORIGINAL STUDENT STATE FIXTURE'
    await writeFile(path, raw)
    fault.deniedSuffix = operation === 'syllabus' ? 'syllabus.json' : 'progress.md'
    const pending = operation === 'syllabus' ? loadSyllabus(root) : operation === 'load-progress' ? loadProgressBoard(path)
      : operation === 'save-progress' ? saveProgressBoard(path, { overallMastery: 0, dueCount: 0, lastUpdatedAt: null, concepts: [] })
      : new SyncApplier(root, root).apply({ concept_updates: [{ id: 'c1', score: 0.8 }], memory_hints: [] })
    await expect(pending).rejects.toMatchObject({ code: 'EACCES' })
    fault.deniedSuffix = ''
    expect(await readFile(path, 'utf8')).toBe(raw)
  })
});
