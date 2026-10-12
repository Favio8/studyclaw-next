/**
 * 对抗性审查发现的三个真实缺陷的回归守卫：
 *
 * 1. **导入暂存目录必须在 targetRoot 之内**。曾用 `os.tmpdir()`，工作区在 D:、
 *    TEMP 在 C: 时最后一步 `rename` 抛 **EXDEV**——`studyclaw import` 对所有
 *    真实用户都会失败，而全部既有测试都把两侧放在 tmpdir，恰好掩盖了它。
 * 2. **ZIP 的 general purpose bit 11（UTF-8 文件名标志）必须置位**，否则严格
 *    的解压工具按本地代码页解码文件名，中文课程名乱码。
 * 3. **归档必须能被第三方工具读取**——只跟自己的 reader 往返自洽是不够的，
 *    自洽但不合规的格式一样会在用户手里炸。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip, readZip } from '../src/zip.ts'
import { createCourseBackup, EXPORT_FORMAT_VERSION, ImportError, importCourseBackup } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function course(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-adv-'))
  tmpRoots.push(root)
  const src = join(root, '机器学习')
  await mkdir(join(src, '.studyclaw'), { recursive: true })
  await writeFile(join(src, '.studyclaw', 'progress.md'), '# 学习进度\n跨盘测试\n', 'utf8')
  return src
}

describe('导入暂存目录的位置', () => {
  it('不在系统 TEMP 里留任何暂存残留（暂存必须建在目标根之内）', async () => {
    const src = await course()
    const backup = await createCourseBackup(src)
    const targetRoot = join(await mkdtemp(join(tmpdir(), 'studyclaw-tgt-')), 'ws')
    await mkdir(targetRoot, { recursive: true })

    const before = new Set(await readdir(tmpdir()).catch(() => [] as string[]))
    await importCourseBackup(backup, targetRoot)
    const after = await readdir(tmpdir()).catch(() => [] as string[])

    const leaked = after.filter(name => !before.has(name) && name.startsWith('studyclaw-import-'))
    expect(leaked, `暂存目录泄漏到系统 TEMP：${leaked.join(', ')}`).toEqual([])
    // 目标根内也不该留下暂存残骸。
    const residue = await readdir(targetRoot).catch(() => [] as string[])
    expect(residue.filter(name => name.startsWith('.studyclaw-import-'))).toEqual([])
  })

  it('跨卷还原（C: 的 TEMP → 其他卷的目标）', async (context) => {
    const src = await course()
    const backup = await createCourseBackup(src)
    // 目标放在当前工作区所在卷（与 tmpdir 大概率不同卷）——这正是生产形态。
    const targetRoot = join(join(process.cwd(), '..', 'node_modules', '.cache'), `studyclaw-import-probe-${Date.now().toString(36)}`)
    if (parse(targetRoot).root.toLowerCase() === parse(tmpdir()).root.toLowerCase()) {
      // 单卷环境无法构造该场景，跳过而不是给一个假绿。
      context.skip()
      return
    }
    await mkdir(targetRoot, { recursive: true })
    try {
      const result = await importCourseBackup(backup, targetRoot)
      expect(result.courseId).toBe('机器学习')
      expect(await readFile(join(targetRoot, '机器学习', '.studyclaw', 'progress.md'), 'utf8')).toContain('跨盘测试')
    } finally {
      await rm(targetRoot, { recursive: true, force: true })
    }
  }, 30000)

  it('损坏清单在 force 安装前拒绝，旧数据保持原位', async () => {
    const src = await course()
    const backup = await createCourseBackup(src)
    const targetRoot = await mkdtemp(join(tmpdir(), 'studyclaw-force-'))
    tmpRoots.push(targetRoot)
    await mkdir(join(targetRoot, '机器学习', '.studyclaw'), { recursive: true })
    await writeFile(join(targetRoot, '机器学习', '.studyclaw', 'progress.md'), '旧数据', 'utf8')

    // 损坏归档 → 在 force 的"删旧目标"之前就失败，旧数据必须完好。
    const broken = createZip([{ path: 'studyclaw-export.json', data: Buffer.from('{oops') }])
    await expect(importCourseBackup(broken, targetRoot, { force: true })).rejects.toThrow()
    expect(await readFile(join(targetRoot, '机器学习', '.studyclaw', 'progress.md'), 'utf8')).toBe('旧数据')
  })
})

describe('ZIP 格式合规', () => {
  it('general purpose bit 11（UTF-8 文件名）置位', () => {
    const zip = createZip([{ path: '中文名.txt', data: Buffer.from('x') }])
    expect(zip.readUInt16LE(6) & 0x0800).not.toBe(0)
    // 中央目录里也必须一致。
    const eocd = zip.length - 22
    const centralOffset = zip.readUInt32LE(eocd + 16)
    expect(zip.readUInt16LE(centralOffset + 8) & 0x0800).not.toBe(0)
  })

  it('第三方工具能读出中文条目名与解压后的内容', async () => {
    const zip = createZip([
      { path: '.studyclaw/中文笔记.md', data: Buffer.from('# 学习进度\n'.repeat(100), 'utf8') },
      { path: '.studyclaw/tasks/task_0001.json', data: Buffer.from('{}', 'utf8') },
    ])
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-zipx-'))
    tmpRoots.push(root)
    const file = join(root, 'out.zip')
    await writeFile(file, zip)
    let out: string
    if (process.platform === 'win32') {
      const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ` +
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$z=[System.IO.Compression.ZipFile]::OpenRead('${file.replace(/'/g, "''")}'); ` +
        `try { $z.Entries | ForEach-Object { $_.FullName; $r=[IO.StreamReader]::new($_.Open()); try { $r.ReadToEnd() } finally { $r.Dispose() } } } finally { $z.Dispose() }`
      out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    } else {
      out = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(n+"\\n"+z.read(n).decode("utf-8") for n in z.namelist()))', file], { encoding: 'utf8' })
    }
    expect(out).toContain('.studyclaw/中文笔记.md')
    expect(out).toContain('# 学习进度')
    expect(out).toContain('.studyclaw/tasks/task_0001.json')
  })

  it('自身读写往返仍然一致', () => {
    const entries = [{ path: '.studyclaw/笔记.md', data: Buffer.from('内容', 'utf8') }]
    const restored = readZip(createZip(entries))
    expect(restored[0]!.path).toBe('.studyclaw/笔记.md')
    expect(restored[0]!.data.toString('utf8')).toBe('内容')
  })

  it.skipIf(process.platform === 'win32')('系统 unzip 认为归档结构合规（非仅自洽）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-unzip-'))
    tmpRoots.push(root)
    const file = join(root, 'out.zip')
    await writeFile(file, createZip([
      { path: '.studyclaw/progress.md', data: Buffer.from('# 学习进度\n', 'utf8') },
      { path: '.studyclaw/tasks/task_0001.json', data: Buffer.from('{"q":"题目"}', 'utf8') },
    ]))
    execFileSync('unzip', ['-t', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }, 20_000)
})

describe('归档格式版本矩阵', () => {
  const manifest = (version: unknown) => Buffer.from(JSON.stringify({ studyclaw_export: version, course_id: 'c1' }), 'utf8')

  it('当前版本可导入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-ver-'))
    tmpRoots.push(root)
    const archive = createZip([
      { path: 'studyclaw-export.json', data: manifest(EXPORT_FORMAT_VERSION) },
      { path: '.studyclaw/progress.md', data: Buffer.from('# 学习进度\n', 'utf8') },
    ])
    const result = await importCourseBackup(archive, root)
    expect(result.courseId).toBe('c1')
  })

  it('未来版本被拒绝并提示升级（不得尽力而为地部分恢复）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-ver-'))
    tmpRoots.push(root)
    const archive = createZip([
      { path: 'studyclaw-export.json', data: manifest(EXPORT_FORMAT_VERSION + 1) },
      { path: '.studyclaw/progress.md', data: Buffer.from('未来的数据\n', 'utf8') },
    ])
    await expect(importCourseBackup(archive, root)).rejects.toThrow(/备份版本不受支持/)
    // 拒绝时不得留下任何半成品目录。
    expect(await readdir(root).catch(() => [])).toEqual([])
  })

  it('版本字段缺失/类型错误同样被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-ver-'))
    tmpRoots.push(root)
    for (const bad of [{ course_id: 'c1' }, { studyclaw_export: '1', course_id: 'c1' }, { studyclaw_export: null }]) {
      const archive = createZip([{ path: 'studyclaw-export.json', data: Buffer.from(JSON.stringify(bad), 'utf8') }])
      await expect(importCourseBackup(archive, root)).rejects.toBeInstanceOf(ImportError)
    }
  })
})
