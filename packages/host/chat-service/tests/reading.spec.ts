import { loadParsedManifest } from '@studyclaw/course-builder'
/**
 * Reading service（PRD 需求三）：annotations.json 的 CRUD、损坏恢复、进度
 * percent 归一、导出分组，以及 readText 的路径守卫。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsedFileName, saveParsedManifest, loadProgressBoard, writeParsedText } from '@studyclaw/course-builder'
import { ReadingService, loadReviewHints } from '../src/reading.ts'
import { defaultToolRegistry } from '@studyclaw/tools'

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

describe('M2：复习回看原文（loadReviewHints）', () => {
  it('按概念聚合标注，取最近 2 条，prefix/suffix 截断到 60 字符', async () => {
    const root = await workspace()
    const service = new ReadingService()
    // 直接写标注文件以控制 createdAt（服务接口总是写"现在"）。
    const path = join(root, '.studyclaw', 'annotations.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      sources: {
        'sources/a.pdf': {
          progress: { page: 1, percent: 0, updatedAt: '' },
          highlights: [
            { id: 'h1', page: 1, rects: [], quote: { text: '最旧', prefix: '', suffix: '' }, color: 'yellow', comment: '', tags: [], conceptId: 'c_x', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'h2', page: 2, rects: [], quote: { text: '中间', prefix: '', suffix: '' }, color: 'yellow', comment: '', tags: [], conceptId: 'c_x', createdAt: '2026-06-01T00:00:00.000Z' },
            { id: 'h3', page: 3, rects: [], quote: { text: '最新', prefix: 'A'.repeat(80), suffix: 'B'.repeat(80) }, color: 'yellow', comment: '', tags: [], conceptId: 'c_x', createdAt: '2026-09-01T00:00:00.000Z' },
            { id: 'h4', page: 4, rects: [], quote: { text: '别的概念', prefix: '', suffix: '' }, color: 'yellow', comment: '', tags: [], conceptId: 'c_y', createdAt: '2026-09-02T00:00:00.000Z' },
            { id: 'h5', page: 5, rects: [], quote: { text: '未关联', prefix: '', suffix: '' }, color: 'yellow', comment: '', tags: [], conceptId: null, createdAt: '2026-09-03T00:00:00.000Z' },
          ],
        },
      },
    }), 'utf8')

    const hints = await loadReviewHints(root, ['c_x'])
    const forX = hints.get('c_x')!
    expect(forX).toHaveLength(2)
    // 最近的优先：h3 在前，h2 次之，h1 被截掉。
    expect(forX.map(hint => hint.text)).toEqual(['最新', '中间'])
    expect(forX[0]!.source).toBe('sources/a.pdf')
    expect(forX[0]!.page).toBe(3)
    expect(forX[0]!.prefix).toHaveLength(61) // 60 字符 + 省略号
    expect(forX[0]!.prefix.endsWith('…')).toBe(true)
    // 只请求 c_x → 不返回 c_y 的线索。
    expect(hints.has('c_y')).toBe(false)
    await expect(service.listHighlights(root, 'sources/a.pdf')).resolves.toHaveLength(5)
  })

  it('没有任何标注时返回空 Map（复习流照常可用）', async () => {
    const root = await workspace()
    await expect(loadReviewHints(root, ['c_x'])).resolves.toEqual(new Map())
  })

  it('标注文件损坏时降级为空，不把错误抛给复习流', async () => {
    const root = await workspace()
    await writeFile(join(root, '.studyclaw', 'annotations.json'), '{"version":1,"sources":[]}', 'utf8')
    // 结构损坏会被既有恢复路径重建；无论恢复与否都不应向调用方抛错。
    await expect(loadReviewHints(root, ['c_x'])).resolves.toBeInstanceOf(Map)
  })

  it('入参概念为空时直接返回空 Map，不读盘', async () => {
    const root = await workspace()
    await writeFile(join(root, '.studyclaw', 'annotations.json'), 'not json', 'utf8')
    await expect(loadReviewHints(root, [])).resolves.toEqual(new Map())
  })
})

describe('M1：划线即证据（exposure 回写 progress.md）', () => {
  async function boardText(root: string): Promise<string> {
    return readFile(join(root, '.studyclaw', 'progress.md'), 'utf8')
  }

  it('关联了概念的标注会累加该概念的阅读接触次数', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, conceptId: 'c_sm2' })
    expect(await boardText(root)).toContain('| `c_sm2` ')
    const after = await loadProgressBoard(join(root, '.studyclaw', 'progress.md'))
    expect(after.concepts.find(c => c.conceptId === 'c_sm2')).toMatchObject({ exposure: 1, evals: 0 })
  })

  it('conceptId 为 null 时不产生曝光行——未关联的划线不污染看板', async () => {
    const root = await workspace()
    await new ReadingService().addHighlight(root, 'sources/a.pdf', HIGHLIGHT_INPUT)
    await expect(readFile(join(root, '.studyclaw', 'progress.md'), 'utf8')).rejects.toThrow()
  })

  it('多次划线累加，且不改变掌握度与复习排期', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, conceptId: 'c_sm2' })
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, page: 4, conceptId: 'c_sm2' })
    const board = await loadProgressBoard(join(root, '.studyclaw', 'progress.md'))
    expect(board.concepts[0]).toMatchObject({ exposure: 2, mastery: 0, nextReviewAt: null, evals: 0 })
    // 标注本身照常保存了两条。
    expect((await service.listHighlights(root, 'sources/a.pdf'))).toHaveLength(2)
  })

  it('曝光写入失败时标注仍然保存成功，用户不报错（非关键遥测）', async () => {
    const root = await workspace()
    // 把 progress.md 变成目录 → 读板必然失败。
    await mkdir(join(root, '.studyclaw', 'progress.md'))
    const created = await new ReadingService().addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, conceptId: 'c_sm2' })
    expect(created.conceptId).toBe('c_sm2')
    expect(await new ReadingService().listHighlights(root, 'sources/a.pdf')).toHaveLength(1)
  })

  it('并发划线（同一概念）曝光累计不丢更新', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await Promise.all([1, 2, 3, 4, 5].map(n =>
      service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, page: n, conceptId: 'c_sm2' })))
    const board = await loadProgressBoard(join(root, '.studyclaw', 'progress.md'))
    expect(board.concepts[0]!.exposure).toBe(5)
    expect(await service.listHighlights(root, 'sources/a.pdf')).toHaveLength(5)
  })
})

describe('ReadingService 标注', () => {
  it.each(['null', '{"version":1,"sources":[]}', '{"version":1,"sources":{"sources/a.pdf":null}}', '{"version":1,"sources":{"sources/a.pdf":{"highlights":[null]}}}'])('结构损坏也备份原文件并安全重建：%s', async raw => {
    const root = await workspace()
    const path = join(root, '.studyclaw', 'annotations.json')
    await writeFile(path, raw, 'utf8')
    const service = new ReadingService()
    const loaded = await service.load(root, 'sources/a.pdf')
    expect(loaded.recovered).toBe(true)
    expect(loaded.progress).toMatchObject({ page: 1, percent: 0 })
    expect(loaded.highlights).toEqual([])
    const backups = (await readdir(join(root, '.studyclaw'))).filter(name => name.startsWith('annotations.json.bak-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, '.studyclaw', backups[0]!), 'utf8')).toBe(raw)
    expect((await service.load(root, 'sources/a.pdf')).recovered).toBe(false)
    await expect(service.traces(root)).resolves.toEqual({ traces: [] })
  })

  it('标注文件不可读时拒绝写入，不把错误当空文件覆盖', async () => {
    const root = await workspace()
    const path = join(root, '.studyclaw', 'annotations.json')
    await mkdir(path)
    await expect(new ReadingService().saveProgress(root, 'a.pdf', 1, 0)).rejects.toThrow()
  })

  it('并发损坏恢复与新标注写入只备份一次，保留新增标注', async () => {
    const root = await workspace()
    await writeFile(join(root, '.studyclaw', 'annotations.json'), '{bad')
    const service = new ReadingService()
    const [loaded, added] = await Promise.all([
      service.load(root, 'sources/a.pdf'),
      service.addHighlight(root, 'sources/a.pdf', HIGHLIGHT_INPUT),
      service.traces(root),
    ])
    // 断言不变量，而不是「哪个调用方恰好看到损坏」：三个调用在课程锁上排队，
    // 谁先拿到锁谁做恢复并把文件换成合法内容。若 addHighlight 先跑，它会顺手
    // 完成恢复，load 随后读到的是干净文件、recovered 自然为 false——这不是缺陷。
    // 原先断言 loaded.recovered===true，全量并行跑时约 1/7 概率假红。
    // 「恢复恰好发生一次」由备份文件的存在与数量证明。
    const backups = (await readdir(join(root, '.studyclaw'))).filter(name => name.startsWith('annotations.json.bak-'))
    expect(backups).toHaveLength(1)
    expect(typeof loaded.recovered).toBe('boolean')
    expect(await service.listHighlights(root, 'sources/a.pdf')).toEqual([added])
  })

  it('特殊资料文件名不读取或污染对象原型', async () => {
    const root = await workspace()
    const service = new ReadingService()
    const created = await service.addHighlight(root, '__proto__', HIGHLIGHT_INPUT)
    expect(await service.listHighlights(root, '__proto__')).toEqual([created])
    expect((await service.load(root, 'constructor')).highlights).toEqual([])
  })

  it('load：目录与缺失文件都判为不存在', async () => {
    const root = await workspace()
    const service = new ReadingService()
    expect((await service.load(root, 'sources/missing.pdf')).exists).toBe(false)
    expect((await service.load(root, 'sources')).exists).toBe(false)
  })

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

describe('ReadingService 解析视图（P2.5）', () => {
  async function sha256(text: string): Promise<string> {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`
  }

  async function seedParsed(content: string, markdown = '# 解析产物\n\n表格与公式保真。\n'): Promise<{ root: string; source: string; sha: string }> {
    const root = await workspace()
    const source = 'sources/handout.html'
    await writeFile(join(root, source), content, 'utf8')
    const sha = await sha256(content)
    const fileName = parsedFileName(sha, 'standard')
    await writeParsedText(join(root, '.studyclaw'), fileName, markdown)
    await saveParsedManifest(join(root, '.studyclaw'), {
      [source]: { sha256: sha, engine: 'mineru', tier: 'standard', out: fileName },
    })
    return { root, source, sha }
  }

  it('manifest 命中且源文件未变：返回产物与引擎档位', async () => {
    const { root, source } = await seedParsed('docx-bytes')
    const service = new ReadingService()
    const payload = await service.parsed(root, source)
    expect(payload.available).toBe(true)
    expect(payload.engine).toBe('mineru')
    expect(payload.tier).toBe('standard')
    expect(payload.markdown).toContain('表格与公式保真')
    expect(payload.reason).toBeNull()
  })

  it('源文件变化：不可用并提示重新构建', async () => {
    const { root, source } = await seedParsed('docx-bytes')
    await writeFile(join(root, source), 'docx-bytes-v2', 'utf8')
    const payload = await new ReadingService().parsed(root, source)
    expect(payload.available).toBe(false)
    expect(payload.reason).toContain('重新构建')
  })

  it('未构建的 HTML 可按需解析，并如实缓存 builtin 结果和原文块', async () => {
    const root = await workspace()
    const html = '<h1>Explicit memory</h1><p>Memory retrieves external records.</p>'
    await writeFile(join(root, 'sources/a.html'), html, 'utf8')
    const payload = await new ReadingService().parsed(root, 'sources/a.html')
    expect(payload.available).toBe(true)
    expect(payload.engine).toBe('builtin')
    expect(payload.markdown).toContain('# Explicit memory')
    expect(payload.blocks?.[0]?.text).toContain('Memory retrieves external records.')
    const cached = await loadParsedManifest(join(root, '.studyclaw'))
    expect(cached['sources/a.html']?.engine).toBe('builtin')
    expect(cached['sources/a.html']?.out).toBeTruthy()
  })

  it('伪装成 DOCX 的普通字节应报解析错误，不能给出伪造可读结果', async () => {
    const root = await workspace()
    const source = 'sources/a.docx'
    await writeFile(join(root, source), 'docx', 'utf8')
    // 本用例保护的不变量是「必须抛错，不得伪造可读结果」，而不是某一句文案。
    // 装了 LibreOffice 时报「文档解析失败（可能损坏或加密）」；CI runner 上没有
    // LibreOffice 时先在 officePreview 就报「Office 预览失败…」。两种都是正确
    // 失败路径，锁死其中一句会让用例随环境红绿。
    await expect(new ReadingService().parsed(root, source)).rejects.toThrow(/解析失败|Office 预览失败/)
  })

})

describe('ReadingService 痕迹与追加笔记（P3）', () => {
  it('v2 课程的首次聊天笔记与阅读导出都追加到同一份 notes.md', async () => {
    const root = await workspace()
    await writeFile(join(root, '.studyclaw', '.layout-v2'), 'v2\n')
    const registry = defaultToolRegistry(root, root)
    const ctx = { courseDir: root, workspaceRoot: root, approval: async () => 'allow' as const }
    expect((await registry.execute('write_note', { content: '首次聊天笔记' }, ctx)).status).toBe('success')
    const path = join(root, '.studyclaw', 'notes.md')
    expect(await readFile(path, 'utf8')).toContain('首次聊天笔记')
    const service = new ReadingService()
    await service.addHighlight(root, 'a.pdf', HIGHLIGHT_INPUT)
    await Promise.all([
      service.appendNotes(root, 'a.pdf'),
      registry.execute('write_note', { content: '并发聊天笔记' }, ctx),
    ])
    const notes = await readFile(path, 'utf8')
    expect(notes).toContain('首次聊天笔记')
    expect(notes).toContain('并发聊天笔记')
    expect(notes).toContain('reading-export')
    await expect(readFile(join(root, 'notes.md'), 'utf8')).rejects.toThrow()
  })

  it('traces 按 conceptId 聚合，无概念关联的标注不计入', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, conceptId: 'c_ef', createdAt: undefined } as Record<string, unknown>)
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, conceptId: 'c_ef' })
    await service.addHighlight(root, 'sources/b.md', { ...HIGHLIGHT_INPUT, conceptId: 'c_x' })
    await service.addHighlight(root, 'sources/b.md', { ...HIGHLIGHT_INPUT, conceptId: null })
    const { traces } = await service.traces(root)
    expect(traces).toHaveLength(2)
    expect(traces[0]).toMatchObject({ conceptId: 'c_ef', count: 2 })
    expect(traces[1]).toMatchObject({ conceptId: 'c_x', count: 1 })
  })

  it('appendNotes：把标注按页分组追加进 notes.md，带来源注释；无标注不写', async () => {
    const root = await workspace()
    const service = new ReadingService()
    expect(await service.appendNotes(root, 'sources/a.pdf')).toEqual({ appended: false, count: 0 })
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, comment: '常考' })
    const result = await service.appendNotes(root, 'sources/a.pdf')
    expect(result).toEqual({ appended: true, count: 1 })
    const notes = await readFile(join(root, '.studyclaw', 'notes.md'), 'utf8')
    expect(notes).toContain('reading-export')
    expect(notes).toContain('source=sources/a.pdf')
    expect(notes).toContain('批注：常考')
    // 二次追加不覆盖首次内容
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, quote: '第二条' })
    await service.appendNotes(root, 'sources/a.pdf')
    const notes2 = await readFile(join(root, '.studyclaw', 'notes.md'), 'utf8')
    expect(notes2).toContain('批注：常考')
    expect(notes2).toContain('第二条')
  })
})

describe('appendNotes 并发串行（回归）', () => {
  it('并发两次追加都落盘，互不覆盖', async () => {
    const root = await workspace()
    const service = new ReadingService()
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, quote: '第一条标注' })
    await service.addHighlight(root, 'sources/a.pdf', { ...HIGHLIGHT_INPUT, quote: '第二条标注' })
    // 同一进程内并发触发两次导出追加。
    const results = await Promise.all([
      service.appendNotes(root, 'sources/a.pdf'),
      service.appendNotes(root, 'sources/a.pdf'),
    ])
    expect(results.every(item => item.appended)).toBe(true)
    const notes = await readFile(join(root, '.studyclaw', 'notes.md'), 'utf8')
    // 两条标注在两次导出中都出现（后一次覆盖前一次会只剩一份）。
    expect(notes.match(/第一条标注/g)?.length).toBe(2)
    expect(notes.match(/第二条标注/g)?.length).toBe(2)
  })
})
