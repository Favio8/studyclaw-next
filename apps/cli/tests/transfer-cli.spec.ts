/**
 * M3 CLI 接线回归：`export` / `import` 的参数解析、落盘与错误转译。
 * RPC 层用桩替身，验证的是命令自身的编排（选课、格式、输出路径、失败提示）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { hostRpc, hostBinary, hostDownload } = vi.hoisted(() => ({
  hostRpc: vi.fn(),
  hostBinary: vi.fn(),
  hostDownload: vi.fn(),
}))
vi.mock('../src/lib/client.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/client.ts')>()
  return { ...actual, hostRpc, hostBinary, hostDownload, CliError: actual.CliError }
})

import { exportCommand, importCommand } from '../src/commands/transfer.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  hostRpc.mockReset()
  hostBinary.mockReset()
  hostDownload.mockReset()
})

/** makeCourseDeps 的 rpc 与 import/export 的 RPC 都是 hostRpc，按方法名分派。 */
function stubRpc(handlers: Record<string, unknown>): void {
  hostRpc.mockImplementation(async (method: string) => handlers[method])
}

const OPEN_WORKSPACE = { current: 'D:/ws' }
const ONE_COURSE = { courses: [{ id: 'c1', title: '机器学习', overallMastery: 0.8, dueToday: 1, lastActiveAt: null }], missing: false }

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-transfer-'))
  tmpRoots.push(root)
  return root
}

describe('M3 export 命令', () => {
  it('默认导出 markdown 并写入 --out 指定路径（走二进制通道）', async () => {
    const root = await dir()
    stubRpc({ 'workspaces.list': OPEN_WORKSPACE, 'workspaces.courses': ONE_COURSE })
    hostDownload.mockResolvedValue(Buffer.from('# 机器学习\n内容', 'utf8'))
    const out = join(root, '导出.md')

    await exportCommand(['--course', 'c1', '--out', out])

    expect(hostDownload).toHaveBeenCalledWith('/api/courses.export?courseId=c1&format=markdown')
    expect(await readFile(out, 'utf8')).toContain('# 机器学习')
  })

  it('--format backup 走归档格式', async () => {
    const root = await dir()
    stubRpc({ 'workspaces.list': OPEN_WORKSPACE, 'workspaces.courses': ONE_COURSE })
    hostDownload.mockResolvedValue(Buffer.from('PK-binary', 'utf8'))
    const out = join(root, '备份.zip')

    await exportCommand(['--course', 'c1', '--format', 'backup', '--out', out])

    expect(hostDownload).toHaveBeenCalledWith('/api/courses.export?courseId=c1&format=backup')
    // 写出的必须是原始字节，不是 base64 文本。
    expect((await readFile(out)).equals(Buffer.from('PK-binary', 'utf8'))).toBe(true)
  })

  it('课程 id 需要 URL 编码（中文名不能拼进查询串）', async () => {
    const root = await dir()
    hostRpc.mockImplementation(async (method: string) => (
      method === 'workspaces.list'
        ? OPEN_WORKSPACE
        : { courses: [{ id: '机器学习', title: '机器学习', overallMastery: 0, dueToday: 0, lastActiveAt: null }], missing: false }
    ))
    hostDownload.mockResolvedValue(Buffer.from('x'))
    await exportCommand(['--out', join(root, 'a.md')])
    expect(hostDownload).toHaveBeenCalledWith('/api/courses.export?courseId=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0&format=markdown')
  })

  it('未知 --format 报用法错误，不发请求', async () => {
    await expect(exportCommand(['--course', 'c1', '--format', 'pdf'])).rejects.toThrow(/--format/)
    expect(hostDownload).not.toHaveBeenCalled()
  })
})

describe('M3 import 命令', () => {
  it('以原始字节 POST 提交归档，默认不 force', async () => {
    const root = await dir()
    const archive = join(root, 'backup.zip')
    await writeFile(archive, 'PK-content', 'utf8')
    hostBinary.mockResolvedValue({ courseId: '机器学习', files: 7 })

    await importCommand([archive])

    // 不能是 base64 文本——JSON 请求体 2 MiB 上限会先把它掐死。
    expect(hostBinary).toHaveBeenCalledWith('/api/courses.import', { method: 'POST', body: Buffer.from('PK-content', 'utf8') })
  })

  it('--force 与 --course-id 进查询串并编码', async () => {
    const root = await dir()
    const archive = join(root, 'backup.zip')
    await writeFile(archive, 'PK', 'utf8')
    hostBinary.mockResolvedValue({ courseId: '期末复习', files: 1 })

    await importCommand([archive, '--course-id', '期末复习', '--force'])

    expect(hostBinary).toHaveBeenCalledWith(
      '/api/courses.import?courseId=%E6%9C%9F%E6%9C%AB%E5%A4%8D%E4%B9%A0&force=1',
      { method: 'POST', body: Buffer.from('PK', 'utf8') },
    )
  })

  it('缺少归档路径报用法错误', async () => {
    await expect(importCommand([])).rejects.toThrow(/用法/)
  })

  it('还原失败转成可读错误，而不是把原始错误甩出去', async () => {
    const root = await dir()
    const archive = join(root, 'backup.zip')
    await writeFile(archive, 'PK', 'utf8')
    hostBinary.mockRejectedValue(new Error('目标「机器学习」已存在：已拒绝导入以免覆盖现有学习数据'))

    await expect(importCommand([archive])).rejects.toThrow(/已拒绝导入/)
  })
})
