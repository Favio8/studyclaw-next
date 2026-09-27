/**
 * BUG-001/NEW-004 回归：read_file/write_file 的符号链接越界必须被拒绝；
 * 指向工作区内部的符号链接则解析到真实路径后正常读写（加固不误伤）。
 * Windows 无开发者模式/管理员权限时 symlink 创建会 EPERM——探测不支持时
 * 跳过对应用例（CI/有权限环境仍然覆盖）。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handlerReadFile, handlerReadSource, handlerWriteFile, type ToolContext } from '../src/handlers.ts'
import { ToolRejected } from '../src/result.ts'

const workspace = await mkdtemp(join(tmpdir(), 'studyclaw-pathsafety-'))
const outsideDir = await mkdtemp(join(tmpdir(), 'studyclaw-outside-'))
await mkdir(join(workspace, 'docs'), { recursive: true })
await writeFile(join(workspace, 'docs', 'note.md'), '# hello', 'utf8')
await writeFile(join(workspace, 'docs', 'rs.md'), '# line1\nline2', 'utf8')
const outsideSecret = join(outsideDir, 'secret.txt')
await writeFile(outsideSecret, 'top-secret', 'utf8')

let symlinkSupported = true
try {
  await symlink(outsideSecret, join(workspace, 'leak.txt'), 'file')
  await symlink(join(workspace, 'docs', 'note.md'), join(workspace, 'alias.md'), 'file')
} catch {
  symlinkSupported = false
}

// Windows 无特权也能创建目录 junction：用它覆盖"目录型符号链接越界"路径，
// 保证在本机（非 CI）也有 ALWAYS-RUN 的 BUG-001 覆盖。
let junctionSupported = true
try {
  await symlink(outsideDir, join(workspace, 'leakdir'), 'junction')
} catch {
  junctionSupported = false
}

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(outsideDir, { recursive: true, force: true })
})

const ctx: ToolContext = { courseDir: workspace, workspaceRoot: workspace }

describe('read_file 符号链接安全', () => {
  it.runIf(symlinkSupported)('拒绝指向工作区外的符号链接（防越界读取）', async () => {
    await expect(handlerReadFile(ctx, { path: 'leak.txt' })).rejects.toBeInstanceOf(ToolRejected)
    // 工作区外文件原样未动。
    await expect(readFile(outsideSecret, 'utf8')).resolves.toBe('top-secret')
  })

  it.runIf(symlinkSupported)('指向工作区内部的符号链接解析后正常读取', async () => {
    const [message, data] = await handlerReadFile(ctx, { path: 'alias.md' })
    expect((data as { content: string }).content).toBe('# hello')
    // 返回的路径仍是用户请求的相对路径，不是解析后的内部路径。
    expect((data as { path: string }).path).toBe('alias.md')
    expect(message).toContain('已读取')
  })
})

describe('write_file 符号链接安全', () => {
  it.runIf(symlinkSupported)('拒绝把指向工作区外的既有符号链接作为写入目标', async () => {
    await expect(handlerWriteFile(ctx, { path: 'leak.txt', content: 'pwned' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(readFile(outsideSecret, 'utf8')).resolves.toBe('top-secret')
  })

  it.runIf(symlinkSupported)('指向工作区内部的符号链接写入解析后的目标文件', async () => {
    await handlerWriteFile(ctx, { path: 'alias.md', content: '# updated' })
    await expect(readFile(join(workspace, 'docs', 'note.md'), 'utf8')).resolves.toBe('# updated')
  })

  it('拒绝绝对越界路径（.. 逃逸/外部绝对路径）', async () => {
    await expect(handlerWriteFile(ctx, { path: '../escape.txt', content: 'x' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(handlerReadFile(ctx, { path: outsideSecret })).rejects.toBeInstanceOf(ToolRejected)
  })
})

describe('目录 junction 越界（Windows 无特权可复现的 BUG-001 覆盖）', () => {
  it.runIf(junctionSupported)('read_file 拒绝经 junction 读取工作区外文件', async () => {
    await expect(handlerReadFile(ctx, { path: 'leakdir/secret.txt' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(readFile(outsideSecret, 'utf8')).resolves.toBe('top-secret')
  })

  it.runIf(junctionSupported)('write_file 拒绝经 junction 写入工作区外目录', async () => {
    await expect(handlerWriteFile(ctx, { path: 'leakdir/pwned.txt', content: 'x' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(readFile(outsideSecret, 'utf8')).resolves.toBe('top-secret')
  })
})

describe('read_source 课程资料路径安全（对抗性审查：resolveSourceRef 不解析符号链接）', () => {
  it.runIf(junctionSupported)('拒绝经 junction 读取课程资料根之外的文件', async () => {
    await expect(handlerReadSource(ctx, { path: 'leakdir/secret.txt' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(readFile(outsideSecret, 'utf8')).resolves.toBe('top-secret')
  })

  it('正常读取课程资料内的文件（行号切片语义不变）', async () => {
    const [, data] = await handlerReadSource(ctx, { path: 'docs/rs.md' })
    const view = data as { lines: Array<{ n: number; text: string }>; totalLines: number }
    expect(view.totalLines).toBe(2)
    expect(view.lines[0]).toEqual({ n: 1, text: '# line1' })
  })
})

describe('T-1：Windows 8.3 短名别名拒绝', () => {
  // 本机实测：C: 卷上 `.studyclaw` 有 8.3 别名 `STUDYC~1`，Node realpath 不展开
  // 短名——字符串 containment 放行 `STUDYC~1/progress.md` 之类引用，点目录/状态
  // 目录排除被绕过（模型可直读题池答案键）。判定是纯字符串规则，跨平台可测。
  it('read_file / read_source 拒绝以 ~数字 结尾的路径段', async () => {
    await expect(handlerReadFile(ctx, { path: 'STUDYC~1/progress.md' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(handlerReadSource(ctx, { path: 'STUDYC~1/progress.md' })).rejects.toBeInstanceOf(ToolRejected)
    await expect(handlerReadFile(ctx, { path: 'docs/STUDYC~1/note.md' })).rejects.toBeInstanceOf(ToolRejected)
  })

  it('write_file 同样拒绝 8.3 形态段', async () => {
    await expect(handlerWriteFile(ctx, { path: 'STUDYC~1/x.md', content: 'x' })).rejects.toBeInstanceOf(ToolRejected)
  })

  it('合法文件名不受影响（backup~1.txt 不以 ~数字 结尾，放行）', async () => {
    await writeFile(join(workspace, 'backup~1.txt'), 'legit', 'utf8')
    const [, data] = await handlerReadFile(ctx, { path: 'backup~1.txt' })
    expect((data as { content: string }).content).toBe('legit')
  })
})

describe('T-12：异盘绝对路径 containment（Windows）', () => {
  it.runIf(process.platform === 'win32')('跨盘绝对路径被拒（relative 产物为绝对形态，旧判定放行）', async () => {
    // C: 上的工作区，D: 的绝对路径：relative('C:\\ws','D:\\x') = 'D:\\x'，
    // 不以 '../' 开头 → 旧实现放行（跨盘逃逸原语）。
    const otherDrive = process.cwd().split(':')[0] === 'C' ? 'D:\\__studyclaw_probe__.md' : 'C:\\__studyclaw_probe__.md'
    await expect(handlerReadFile(ctx, { path: otherDrive })).rejects.toBeInstanceOf(ToolRejected)
    await expect(handlerWriteFile(ctx, { path: otherDrive, content: 'x' })).rejects.toBeInstanceOf(ToolRejected)
  })
})

describe('T-15：Windows 保留设备名', () => {
  it.runIf(process.platform === 'win32')('保留设备名作为文件名被拒（旧实现写入"成功"但数据进设备被弃）', async () => {
    for (const name of ['CON', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT1', 'con.txt']) {
      await expect(handlerWriteFile(ctx, { path: name, content: 'x' })).rejects.toBeInstanceOf(ToolRejected)
    }
  })
})
