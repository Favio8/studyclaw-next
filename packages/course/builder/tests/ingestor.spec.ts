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
})
