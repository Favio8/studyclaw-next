/**
 * Ingestor suite: two-level outline slicing, Chinese slug fallback,
 * chunk size cap, and granularity behavior.
 */

import { MarkdownIngestor, slug } from '../src/ingestor.ts'

const SAMPLE = [
  '---',
  'title: 多态专题',
  '---',
  '# 多态',
  '',
  '引言：面向对象的三大特性之一。',
  '',
  '## 重载与覆写',
  '',
  '重载（overload）是同一类中同名不同参数。',
  '',
  '覆写（override）是子类重定义父类方法。',
  '',
  '### 边界情况',
  '',
  '静态方法可以被隐藏但不能覆写。',
  '',
  '## 实践练习',
  '',
  '请写出一个覆写的例子。',
  '',
].join('\n')

describe('MarkdownIngestor', () => {
  it('builds a two-level syllabus and chunks from headings', () => {
    const ingestor = new MarkdownIngestor()
    const artifact = ingestor.parseText(SAMPLE, 'polymorphism.md', 'c1')
    expect(artifact.meta['title']).toBe('多态专题')
    expect(artifact.syllabus.title).toBe('多态专题')
    expect(artifact.syllabus.chapters).toHaveLength(1)
    const chapter = artifact.syllabus.chapters[0]!
    expect(chapter.title).toBe('多态')
    const names = chapter.concepts.map(concept => concept.name)
    expect(names).toContain('重载与覆写')
    expect(names).toContain('实践练习')
    expect(artifact.chunks.length).toBeGreaterThan(1)
    const overriding = chapter.concepts.find(concept => concept.name === '重载与覆写')!
    const chunk = artifact.chunks.find(c => c.concept_id === overriding.id)
    expect(chunk?.content).toContain('覆写（override）')
    // 章引言自成一段概念
    const intro = chapter.concepts.find(concept => concept.name === '多态')!
    const introChunk = artifact.chunks.find(c => c.concept_id === intro.id)
    expect(introChunk?.content).toContain('引言：面向对象的三大特性之一。')
  })

  it('repeats a chunk when the section content exceeds the cap', () => {
    const long = [
      '# 章',
      '## 概',
      ...Array.from({ length: 30 }, (_, i) => [`第 ${i} 段，包含若干文字内容用于撑大段落。`, '']).flat(),
    ].join('\n')
    const art = new MarkdownIngestor(200).parseText(long, 'long.md', 'c1')
    const chunks = art.chunks.filter(chunk => chunk.concept_id === art.syllabus.chapters[0]!.concepts[0]!.id)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('coarse granularity keeps one concept per chapter', () => {
    const art = new MarkdownIngestor(undefined, 'coarse').parseText(SAMPLE, 'p.md', 'c1')
    expect(art.syllabus.chapters[0]!.concepts).toHaveLength(1)
  })

  it('slug falls back to md5 for Chinese-only titles and dedupes ids', () => {
    const seen = new Set<string>()
    const id1 = slug('重载与覆写', 'c_', seen)
    const id2 = slug('重载与覆写', 'c_', seen)
    expect(id1).not.toBe(id2)
    expect(id1).toMatch(/^c_[0-9a-f]{8}$/)
    expect(id2).toBe(`${id1}_2`)
  })

  it('drops pure-ASCII code-label headings in pdf mode even without fences', () => {
    // 真实形态：PDF 把代码块拍平成纯文本，原 shell 注释行变成裸 `# 标签`，
    // 全文没有任何围栏——标签必须无条件剔除，正文并入上一节。
    const pdf = [
      '一、预备知识',
      '',
      '本章介绍调用大模型 API 的基础概念。',
      '# Response',
      'curl --request POST \\',
      '--url "${BASE_URL}/responses" \\',
      '--data "{ \\"model\\": \\"gpt\\" }"',
      '}"',
    ].join('\n')
    const art = new MarkdownIngestor().parseText(pdf, 'lecture.pdf', 'c1')
    expect(art.syllabus.chapters).toHaveLength(1)
    const names = art.syllabus.chapters[0]!.concepts.map(concept => concept.name)
    expect(names).toEqual(['预备知识'])
    // 标签下的代码内容不丢，归入章节引言概念的 chunk
    const chunk = art.chunks.find(c => c.concept_id === art.syllabus.chapters[0]!.concepts[0]!.id)
    expect(chunk?.content).toContain('curl --request POST')
  })

  it('absorbs a demoted label subsection into its predecessor (tier-2)', () => {
    const pdf = [
      '一、预备知识',
      '',
      '概述调用方式。',
      '',
      '## 请求格式',
      '',
      '请求体为 JSON 对象。',
      '',
      '# Chat Completions',
      '',
      'curl --request POST \\',
      '--url "${BASE_URL}/chat/completions" \\',
      '--data "{ temperature: 0.7 }"',
      '}',
    ].join('\n')
    const art = new MarkdownIngestor().parseText(pdf, 'lecture.pdf', 'c1')
    const chapter = art.syllabus.chapters[0]!
    const names = chapter.concepts.map(concept => concept.name)
    expect(names).not.toContain('Chat Completions')
    expect(names).toContain('请求格式')
    const formatConcept = chapter.concepts.find(concept => concept.name === '请求格式')!
    const chunk = art.chunks.find(c => c.concept_id === formatConcept.id)
    expect(chunk?.content).toContain('curl --request POST')
    expect(chunk?.content).toContain('temperature')
  })

  it('drops bare-ASCII headed demo blocks but keeps CJK titles in pdf mode', () => {
    const pdf = [
      '一、系统设计',
      '',
      '总体架构介绍。',
      '# Overview',
      '',
      'The system follows a layered architecture.',
      '# 概览补充',
      '',
      '这里是中文小节标题，必须保留为独立概念。',
    ].join('\n')
    const art = new MarkdownIngestor().parseText(pdf, 'design.pdf', 'c1')
    const names = art.syllabus.chapters[0]!.concepts.map(concept => concept.name)
    expect(names).not.toContain('Overview') // 纯英文标签按伪标题处理
    expect(names).toContain('概览补充') // 含 CJK 的标题不受影响
  })

  it('keeps native markdown structure untouched by the label filter', () => {
    const md = [
      '# Response',
      '',
      'HTTP 响应结构说明。',
      '',
      '```json',
      '{ "ok": true }',
      '```',
    ].join('\n')
    const art = new MarkdownIngestor().parseText(md, 'http-notes.md', 'c1')
    const names = art.syllabus.chapters[0]!.concepts.map(concept => concept.name)
    expect(names).toContain('Response')
  })

  it('maps mis-encoded Kangxi radical code points back to real ideographs', () => {
    // 实证自 harness讲义.pdf：字体把「行」编码为 U+2F8F，老表错映射成「襾」
    const pdf = `一、抓取并理解 Claude Code 的运\u2F8F轨迹\n\n记录执\u2F8F\u2F2F具调⽤和常\u2EC5形式。`
    const art = new MarkdownIngestor().parseText(pdf, 'lecture.pdf', 'c1')
    expect(art.syllabus.chapters[0]!.title).toBe('抓取并理解 Claude Code 的运行轨迹')
    const chunk = art.chunks[0]
    expect(chunk?.content).toContain('执行工具调用')
    expect(chunk?.content).toContain('常见形式')
    expect(chunk?.content).not.toContain('\u2F8F')
  })

  it('repairs known PDF font CMap mis-maps phrase-level', () => {
    const pdf = '一、抓取并理解 Claude Code 的运襾轨迹\n\n运行轨迹调试的方法。'
    const art = new MarkdownIngestor().parseText(pdf, 'lecture.pdf', 'c1')
    expect(art.syllabus.chapters[0]!.title).toBe('抓取并理解 Claude Code 的运行轨迹')
  })
})
