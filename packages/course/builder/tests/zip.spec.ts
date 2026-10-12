import { describe, expect, it } from 'vitest'
import { createZip, readZip } from '../src/zip.ts'

describe('最小 ZIP 读写', () => {
  it('多条目往返（含中文路径与二进制内容）', () => {
    const entries = [
      { path: 'progress.md', data: Buffer.from('# 学习进度\n中文内容\n', 'utf8') },
      { path: 'notes/笔记.md', data: Buffer.from('笔记', 'utf8') },
      { path: 'tasks/task_0001.json', data: Buffer.from([0, 1, 2, 250, 251, 252]) },
      { path: 'empty.txt', data: Buffer.alloc(0) },
    ]
    const restored = readZip(createZip(entries))
    expect(restored.map(e => e.path)).toEqual(entries.map(e => e.path))
    for (const [index, entry] of entries.entries()) {
      expect(restored[index]!.data.equals(entry.data)).toBe(true)
    }
  })

  it('大文件走 deflate 且明显变小', () => {
    const data = Buffer.from('学习资料内容'.repeat(5000), 'utf8')
    const zip = createZip([{ path: 'big.txt', data }])
    expect(zip.length).toBeLessThan(data.length / 4)
    expect(readZip(zip)[0]!.data.equals(data)).toBe(true)
  })

  it('空归档可读', () => {
    expect(readZip(createZip([]))).toEqual([])
  })

  it('损坏数据被校验拦下，不当成有效备份', () => {
    const zip = createZip([{ path: 'a.txt', data: Buffer.from('学习进度', 'utf8') }])
    // 翻转压缩载荷中的一个字节
    const damaged = Buffer.from(zip)
    damaged[35] ^= 0xff
    expect(() => readZip(damaged)).toThrow(/校验失败|中央目录损坏|条目损坏/)
  })

  it('非 ZIP 输入给出可读错误', () => {
    expect(() => readZip(Buffer.from('这不是 ZIP'))).toThrow(/不是有效的 ZIP/)
    expect(() => readZip(Buffer.alloc(0))).toThrow(/不是有效的 ZIP/)
  })

  it('拒绝绝对路径与空路径（防止解压逃逸）', () => {
    expect(() => createZip([{ path: '/etc/passwd', data: Buffer.alloc(1) }])).toThrow(/非法归档路径/)
    expect(() => createZip([{ path: '', data: Buffer.alloc(1) }])).toThrow(/非法归档路径/)
  })

  it('Windows 反斜杠路径统一成 /', () => {
    const zip = createZip([{ path: 'tasks\\task_0001.json', data: Buffer.from('{}') }])
    expect(readZip(zip)[0]!.path).toBe('tasks/task_0001.json')
  })

  it('条目数超过上限即报错，不产出半截坏档', () => {
    const many = Array.from({ length: 0x10000 + 1 }, (_, i) => ({ path: `f${i}.txt`, data: Buffer.alloc(0) }))
    expect(() => createZip(many)).toThrow(/归档条目过多/)
  })
})
