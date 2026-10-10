/**
 * MinerU sidecar（PRD 需求一）：探测顺序（PATH → ~/.local/bin → uv tool list）
 * 与解析五态（成功 / 未安装 / 启动失败 / 非零退出 / 超时 / 空输出）。
 *
 * execFile 与 HOME/USERPROFILE/PATH 全部被测试控制，不起真实进程；
 * uv/pipx 的 Windows shim（.exe）与 .cmd 跳过行为也在覆盖范围内。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { MineruError, parseWithMineru, probeMineru, resetMineruProbeCache } from '../src/mineru.ts'

const tmpRoots: string[] = []
let savedEnv: { PATH?: string; HOME?: string; USERPROFILE?: string }

beforeEach(() => {
  resetMineruProbeCache()
  execFileMock.mockReset()
  savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
})

afterEach(async () => {
  if (savedEnv.PATH !== undefined) process.env.PATH = savedEnv.PATH
  if (savedEnv.HOME !== undefined) process.env.HOME = savedEnv.HOME
  if (savedEnv.USERPROFILE !== undefined) process.env.USERPROFILE = savedEnv.USERPROFILE
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'studyclaw-mineru-'))
  tmpRoots.push(dir)
  return dir
}

/** 把 PATH 与 HOME/USERPROFILE 都指向空目录：探测三路全部落空。 */
async function isolateEnvironment(): Promise<void> {
  const dir = await emptyDir()
  process.env.PATH = dir
  process.env.HOME = dir
  process.env.USERPROFILE = dir
}

/** 在 PATH 指向的目录里放一个可执行文件（探测只 stat 不执行）。 */
async function seedOnPath(name: string): Promise<void> {
  const dir = await emptyDir()
  await writeFile(join(dir, name), '', 'utf8')
  process.env.PATH = dir
  process.env.HOME = await emptyDir()
  process.env.USERPROFILE = process.env.HOME
}

describe('probeMineru', () => {
  it('PATH 命中（POSIX 无扩展名 / Windows .exe）', async () => {
    await seedOnPath(process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit')
    const probe = await probeMineru()
    expect(probe.available).toBe(true)
    expect(probe.command).toContain('mineru-kit')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('~/.local/bin 命中（Windows uv shim 目录，默认不在 PATH）', async () => {
    const home = await emptyDir()
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(join(home, '.local', 'bin', process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit'), '', 'utf8')
    process.env.PATH = await emptyDir()
    process.env.HOME = home
    process.env.USERPROFILE = home
    const probe = await probeMineru()
    expect(probe.available).toBe(true)
    expect(probe.command).toContain('.local')
  })

  it('uv tool list 输出含 mineru 时视为已安装', async () => {
    await isolateEnvironment()
    // uv 本身在 PATH（空文件即可），list 输出带 mineru。
    await seedOnPath(process.platform === 'win32' ? 'uv.exe' : 'uv')
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: (e: Error | null, stdout: string) => void) => {
      cb(null, 'mineru v4.0.11\nother-tool v1\n')
    })
    const probe = await probeMineru()
    expect(probe.available).toBe(true)
    expect(probe.command).toBe('mineru-kit')
  })

  it('三路都落空 → 不可用（.cmd/.bat 刻意不接）', async () => {
    await isolateEnvironment()
    // 即使 PATH 里只有 mineru-kit.cmd（全局 pip 安装），也不认。
    const dir = await emptyDir()
    await writeFile(join(dir, 'mineru-kit.cmd'), '', 'utf8')
    process.env.PATH = dir
    const probe = await probeMineru()
    expect(probe.available).toBe(false)
    expect(probe.reason).toBe('not-installed')
  })

  it('探测结果缓存 30s，refresh 强制重探', async () => {
    await seedOnPath(process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit')
    expect((await probeMineru()).available).toBe(true)
    await isolateEnvironment()
    expect((await probeMineru()).available).toBe(true) // 缓存命中
    expect((await probeMineru({ refresh: true })).available).toBe(false) // 强制重探
  })
})

describe('parseWithMineru', () => {
  beforeEach(async () => {
    await seedOnPath(process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit')
  })

  it('成功：读 -o 产物并返回 Markdown；参数不含 --pages（无状态模式默认全本）', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      const outIndex = args.indexOf('-o')
      expect(outIndex).toBeGreaterThanOrEqual(0)
      expect(args).toEqual(['parse', expect.any(String), '-o', expect.any(String), '--tier', 'basic'])
      expect(args).not.toContain('--pages')
      void writeFile(args[outIndex + 1]!, '# 标题\n\nMinerU 正文。\n', 'utf8').then(() => cb(null), cb)
    })
    const markdown = await parseWithMineru('/abs/lecture.pdf', 'basic', 60)
    expect(markdown).toContain('MinerU 正文')
  })

  it('未安装：不起进程，抛 not-installed', async () => {
    await isolateEnvironment()
    await expect(parseWithMineru('/abs/lecture.pdf', 'basic', 60)).rejects.toMatchObject({
      name: 'MineruError',
      code: 'not-installed',
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('启动失败（ENOENT）→ spawn-failed', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      cb(Object.assign(new Error('spawn mineru-kit ENOENT'), { code: 'ENOENT' }))
    })
    await expect(parseWithMineru('/abs/lecture.pdf', 'basic', 60)).rejects.toMatchObject({ code: 'spawn-failed' })
  })

  it('超时（killed）→ timeout', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      cb(Object.assign(new Error('Command failed: timed out'), { killed: true }))
    })
    await expect(parseWithMineru('/abs/lecture.pdf', 'basic', 60)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('非零退出 → nonzero-exit，stderr 摘要进 message', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      cb(Object.assign(new Error('exit status 1'), { code: 1 }), '', 'boom: 模型文件缺失')
    })
    const error = await parseWithMineru('/abs/lecture.pdf', 'standard', 60).catch((exc: unknown) => exc)
    expect(error).toBeInstanceOf(MineruError)
    expect((error as MineruError).code).toBe('nonzero-exit')
    expect((error as Error).message).toContain('模型文件缺失')
  })

  it('空产物 → empty-output', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      const outIndex = args.indexOf('-o')
      void writeFile(args[outIndex + 1]!, '   \n', 'utf8').then(() => cb(null), cb)
    })
    await expect(parseWithMineru('/abs/lecture.pdf', 'basic', 60)).rejects.toMatchObject({ code: 'empty-output' })
  })
})
