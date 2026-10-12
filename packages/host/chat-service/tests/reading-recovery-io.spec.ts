import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ failRead: false, failBackup: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error('permission denied'), { code: 'EACCES' })
  return {
    ...actual,
    readFile: (path: unknown, ...args: unknown[]) => {
      if (faults.failRead && String(path).endsWith('annotations.json')) return Promise.reject(denied())
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...args)
    },
    rename: (from: string, to: string) => {
      if (faults.failBackup && to.includes('annotations.json.bak-')) return Promise.reject(denied())
      return actual.rename(from, to)
    },
  }
})

import { ReadingService } from '../src/reading.ts'

const roots: string[] = []
afterEach(async () => {
  faults.failRead = false
  faults.failBackup = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(raw: string): Promise<{ root: string; stateDir: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-reading-io-'))
  roots.push(root)
  const stateDir = join(root, '.studyclaw')
  await mkdir(stateDir)
  const path = join(stateDir, 'annotations.json')
  await writeFile(path, raw)
  return { root, stateDir, path }
}

describe('标注恢复的 I/O 失败不能覆盖学生数据', () => {
  it('权限读取失败传播原错误，原文件内容保持不变', async () => {
    const raw = '{"version":1,"sources":{}}'
    const { root, path } = await fixture(raw)
    faults.failRead = true
    await expect(new ReadingService().saveProgress(root, 'a.pdf', 3, 30)).rejects.toMatchObject({ code: 'EACCES' })
    faults.failRead = false
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('损坏文件备份失败时停止恢复，不能用空结构覆盖原文件', async () => {
    const raw = '{ damaged data'
    const { root, stateDir, path } = await fixture(raw)
    faults.failBackup = true
    await expect(new ReadingService().saveProgress(root, 'a.pdf', 3, 30)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe(raw)
    expect((await readdir(stateDir)).filter(name => name.includes('.bak-'))).toEqual([])
  })
})
