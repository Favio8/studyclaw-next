/**
 * reading.load 的存在性检查不得整读资料。
 *
 * 该检查过去用 `readFile(path, 'utf8')` 只为判断文件在不在，于是每次打开
 * 资料都会把整份 PDF 读进内存再丢弃（实测 200MB 文件 110ms + 全文分配，
 * 相对 stat 的 0.115ms 差约三个数量级）。reading.load 是每次点开资料都会走
 * 的路径，扫描版大 PDF 上这是纯浪费。
 *
 * 这里把 fs/promises 的 readFile 包一层计数桩来钉住契约：load 判定存在性
 * 时不得触碰被检查的那个文件。单独成文件是因为 ESM 命名空间不可 spy，
 * 必须在模块加载前完成 mock。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readFileCalls: string[] = []

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      readFileCalls.push(String(path))
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)
    },
  }
})

const { ReadingService } = await import('../src/reading.ts')

const roots: string[] = []

beforeEach(() => {
  readFileCalls.length = 0
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-load-stat-'))
  roots.push(root)
  await mkdir(join(root, '.studyclaw'), { recursive: true })
  await mkdir(join(root, 'sources'), { recursive: true })
  return root
}

describe('reading.load 存在性检查', () => {
  it('reading.text 截断大资料时不整读文件', async () => {
    const root = await workspace()
    await writeFile(join(root, 'sources', 'large.md'), Buffer.alloc(4 * 1024 * 1024, 0x41))
    const result = await new ReadingService().readText(root, 'sources/large.md')
    expect(result.text).toHaveLength(200_000)
    expect(result.truncated).toBe(true)
    expect(readFileCalls.some(path => path.endsWith('large.md'))).toBe(false)
  })

  it('判定 .pdf 存在时不整读该文件', async () => {
    const root = await workspace()
    await writeFile(join(root, 'sources', 'big.pdf'), Buffer.alloc(1024 * 64, 0x41))

    const result = await new ReadingService().load(root, 'sources/big.pdf')

    expect(result.exists).toBe(true)
    expect(readFileCalls.some(path => path.endsWith('big.pdf'))).toBe(false)
  })

  it('资料缺失时同样不整读，直接判为不存在', async () => {
    const root = await workspace()
    const result = await new ReadingService().load(root, 'sources/gone.pdf')
    expect(result.exists).toBe(false)
    expect(readFileCalls.some(path => path.endsWith('gone.pdf'))).toBe(false)
  })
})
