/**
 * Reading service（PRD 需求三）：annotations.json 的 CRUD、损坏恢复、进度
 * percent 归一、导出分组，以及 readText 的路径守卫。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadingService } from '../src/reading.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-reading-'))
  tmpRoots.push(root)
  await mkdir(join(root, '.studyclaw'), { recursive: true })
  await mkdir(join(root, 'sources'), { recursive: true })
  return root
}

const HIGHLIGHT_INPUT = {
  page: 3,
  rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
  quote: 'SM-2 的 EF 钳制在 [1.3, 2.9]',
  prefix: '上文',
  suffix: '下文',
  color: 'yellow' as const,
  comment: '',
  tags: [] as string[],
  conceptId: null,
}

describe('ReadingService 标注', () => {
  it('add → list → update → remove 全链路，落盘 annotations.json', async () => {
    const root = await workspace()
    const service = new ReadingService()
    const created = await service.addHighlight(root, 'sources/a.pdf', HIGHLIGHT_INPUT)
    expect(created.id).toMatch(/^hl_/)
    expect(created.rects[0]).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.03 })

    const listed = await service.listHighlights(root, 'sources/a.pdf')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.quote.text).toContain('EF 钳制')

    const updated = await service.updateHighlight(root, 'sources/a.pdf', created.id, { color: 'green', comment: '考点', tags: ['sm2'], conceptId: 'c_ef' })
    expect(updated).toMatchObject({ color: 'green', comment: '考点', tags: ['sm2'], conceptId: 'c_ef' })

    expect(await service.removeHighlight(root, 'sources/a.pdf', created.id)).toBe(true)
    expect(await service.listHighlights(root, 'sources/a.pdf')).toHaveLength(0)
    // 删不存在的 id 返回 false 且不动文件
    expect(await service.removeHighlight(root, 'sources/a.pdf', 'hl_none')).toBe(false)

    const onDisk = JSON.parse(await readFile(join(root, '.studyclaw', 'annotations.json'), 'utf8')) as { version: number }
    expect(onDisk.version).toBe(1)
  })

  it('update 不存在的 id 返回 null', async () => {
    const root = await workspace()
    const service = new ReadingService()
    expect(await service.updateHighlight(root, 'sources/a.pdf', 'hl_none', { color: 'red' })).toBeNull()
  })

  it('rects 越界值被钳到 0-1；非数字 rect 被丢弃', async () => {
    const root = await workspace()
    const service = new ReadingService()
    const created = await service.addHighlight(root, 'sources/a.pdf', {
      ...HIGHLIGHT_INPUT,
      rects: [{ x: -1, y: 2, w: 0.4, h: 0.2 }, { x: 'bad', y: 0, w: 0, h: 0 }],
    })
    expect(created.rects).toEqual([{ x: 0, y: 1, w: 0.4, h: 0.2 }])
  })

  it('标注文件损坏：备份 .bak-* 并重建空结构，load 报 recovered', async () => {
    const root = await workspace()
    await writeFile(join(root, '.studyclaw', 'annotations.json'), '{ 坏 JSON', 'utf8')
    const service = new ReadingService()
    const loaded = await service.load(root, 'sources/a.pdf')
    expect(loaded.recovered).toBe(true)
    expect(loaded.highlights).toEqual([])
    const backups = (await readdir(join(root, '.studyclaw'))).filter(name => name.startsWith('annotations.json.bak-'))
    expect(backups.length).toBe(1)
  })

  it('load 返回视图类型与存在性（pdf / markdown / unsupported）', async () => {
    const root = await workspace()
    await writeFile(join(root, 'sources', 'a.pdf'), 'bytes', 'utf8')
    await writeFile(join(root, 'sources', 'b.md'), '# 标题', 'utf8')
    const service = new ReadingService()
    expect((await service.load(root, 'sources/a.pdf')).view).toBe('pdf')
    expect((await service.load(root, 'sources/a.pdf')).exists).toBe(true)
    expect((await service.load(root, 'sources/b.md')).view).toBe('markdown')
    const missing = await service.load(root, 'sources/gone.pdf')
    expect(missing.view).toBe('pdf')
    expect(missing.exists).toBe(false)
    expect((await service.load(root, 'sources/c.xlsx')).view).toBe('unsupported')
  })
})

describe('ReadingService 进度与导出', () => {
  it('saveProgress：page 钳 ≥1，percent 归一到 0-100', async () => {
    const root = await workspace()
    const service = new ReadingService()
    const progress = await service.saveProgress(root, 'sources/a.pdf', 5, 62.7)
    expect(progress).toMatchObject({ page: 5, percent: 63 })
    expect((await service.saveProgress(root, 'sources/a.pdf', 0, 150)).percent).toBe(100)
    const loaded = await service.load(root, 'sources/a.pdf')
    expect(loaded.progress.page).toBe(1)
  })

  it('exportMarkdown 按页分组，含批注/标签/概念', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await service.addHighlight(root, 'sources/a.pdf', HIGHLIGHT_INPUT)
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, page: 1, quote: '第一页内容', comment: '开头', tags: ['结构'], conceptId: 'c_1' })
    const { markdown, count } = await service.exportMarkdown(root, 'sources/a.pdf')
    expect(count).toBe(2)
    expect(markdown).toContain('## 第 1 页')
    expect(markdown).toContain('## 第 3 页')
    expect(markdown).toContain('第一页内容')
    expect(markdown).toContain('批注：开头')
    expect(markdown).toContain('标签：结构')
    expect(markdown).toContain('概念：c_1')
    // 第 1 页排在第 3 页之前
    expect(markdown.indexOf('第 1 页')).toBeLessThan(markdown.indexOf('第 3 页'))
  })
})

describe('ReadingService readText 守卫', () => {
  it('只读 sources/ 下的 .md/.txt；穿越与非白名单扩展名拒绝', async () => {
    const root = await workspace()
    await writeFile(join(root, 'sources', 'a.md'), '# 正文\n\n内容。', 'utf8')
    await writeFile(join(root, 'secret.md'), '不该被读到', 'utf8')
    await writeFile(join(root, 'sources', 'a.pdf'), 'bytes', 'utf8')
    const service = new ReadingService()
    expect((await service.readText(root, 'sources/a.md')).text).toContain('正文')
    await expect(service.readText(root, 'sources/a.pdf')).rejects.toThrow(/\.md\/\.txt/)
    await expect(service.readText(root, '../secret.md')).rejects.toThrow()
    await expect(service.readText(root, 'sources/gone.md')).rejects.toThrow('资料不存在')
  })
})
