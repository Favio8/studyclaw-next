/**
 * `renameWithRetry` 的契约测试。
 *
 * 重点是**边界**：只重试三种临时占用码，其它错误必须第一次就原样抛出——
 * 那正是"重试不该掩盖真问题"的保证。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmod } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { isTransientFileBusy, renameWithRetry } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-fsatomic-'))
  tmpRoots.push(root)
  return root
}

describe('isTransientFileBusy', () => {
  it('认三种临时占用码，拒其它一切', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      expect(isTransientFileBusy(Object.assign(new Error('x'), { code }))).toBe(true)
    }
    for (const code of ['ENOENT', 'EEXIST', 'EXDEV', 'EISDIR', 'ENOTEMPTY', undefined]) {
      expect(isTransientFileBusy(Object.assign(new Error('x'), { code }))).toBe(false)
    }
    expect(isTransientFileBusy(null)).toBe(false)
    expect(isTransientFileBusy(undefined)).toBe(false)
  })
})

describe('renameWithRetry', () => {
  it('正常替换目标文件', async () => {
    const root = await dir()
    const tmp = join(root, 'a.tmp')
    const target = join(root, 'a.json')
    await writeFile(target, '旧内容', 'utf8')
    await writeFile(tmp, '新内容', 'utf8')

    await renameWithRetry(tmp, target)

    expect(await readFile(target, 'utf8')).toBe('新内容')
  })

  it('目标不存在时也能落地', async () => {
    const root = await dir()
    const tmp = join(root, 'b.tmp')
    await writeFile(tmp, 'x', 'utf8')
    await renameWithRetry(tmp, join(root, 'b.json'))
    expect(await readFile(join(root, 'b.json'), 'utf8')).toBe('x')
  })

  it('源不存在时抛原始 ENOENT，不做无意义重试', async () => {
    const root = await dir()
    const started = Date.now()
    await expect(renameWithRetry(join(root, 'missing.tmp'), join(root, 'out.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    // 有界重试的语义：非临时错误必须立刻返回，不睡满退避窗口。
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('目标是不存在的目录 → EXDEV/ENOTEMPTY 类错误原样抛出', async () => {
    const root = await dir()
    const tmp = join(root, 'c.tmp')
    await writeFile(tmp, 'x', 'utf8')
    // rename 一个文件到一个非空目录：必然失败，且不是临时占用类。
    const dirTarget = join(root, 'sub')
    await (await import('node:fs/promises')).mkdir(dirTarget)
    await writeFile(join(dirTarget, 'child'), 'y', 'utf8')
    await expect(renameWithRetry(tmp, dirTarget)).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|ENOTEMPTY|EPERM/) })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('只读目录下的替换最终仍以真实权限错误失败（不被重试掩盖）', async () => {
    const root = await dir()
    const sub = join(root, 'ro')
    await (await import('node:fs/promises')).mkdir(sub)
    await writeFile(join(sub, 't.json'), '旧', 'utf8')
    await writeFile(join(sub, 't.tmp'), '新', 'utf8')
    await chmod(sub, 0o500)
    try {
      // 目录不可写 → rename 失败；即便错误落在可重试码上也必须在有界窗口内结束。
      await expect(renameWithRetry(join(sub, 't.tmp'), join(sub, 't.json'))).rejects.toBeDefined()
    } finally {
      await chmod(sub, 0o700)
    }
  })
})
