/**
 * F3 阅读概括：章节边界定位与分段覆盖（纯函数）。
 *
 * 这两处决定「当前章节」是否可用、以及长文是否被完整遍历——只读开头却声称
 * 概括全文是最需要防住的错误。
 */

import { describe, expect, it } from 'vitest'
import type { SourceBlock } from '@studyclaw/course-builder'
import { locateChapter, segmentBlocks } from '../src/summary.ts'

function block(page: number, text: string, index = 0): SourceBlock {
  return { id: `p${page}_b${index}`, source: 'doc.pdf', page, text, bbox: null }
}

describe('locateChapter', () => {
  const blocks = [
    block(1, '1. Introduction\n正文 A'),
    block(3, '2. Method\n正文 B'),
    block(7, '3. Results\n正文 C'),
    block(12, '4. Conclusion\n正文 D'),
  ]

  it('定位当前页所属章节并给出真实页码范围', () => {
    const outline = [{ title: 'Introduction' }, { title: 'Method' }, { title: 'Results' }, { title: 'Conclusion' }]
    expect(locateChapter(outline, blocks, 8)).toEqual({ title: 'Results', startPage: 7, endPage: 11 })
    expect(locateChapter(outline, blocks, 1)).toEqual({ title: 'Introduction', startPage: 1, endPage: 2 })
    expect(locateChapter(outline, blocks, 12)).toEqual({ title: 'Conclusion', startPage: 12, endPage: 12 })
  })

  it('不足两个可定位标题时边界不可靠，返回 null（前端显示暂不可用）', () => {
    expect(locateChapter([{ title: 'Introduction' }], blocks, 3)).toBeNull()
    expect(locateChapter([{ title: '不存在' }, { title: '也不存在' }], blocks, 3)).toBeNull()
    expect(locateChapter([], blocks, 3)).toBeNull()
  })
})

describe('segmentBlocks', () => {
  it('按预算顺序分段，不跨段丢弃任何块', () => {
    const blocks = [block(1, 'a'.repeat(10)), block(2, 'b'.repeat(10)), block(3, 'c'.repeat(10)), block(4, 'd'.repeat(10))]
    const segments = segmentBlocks(blocks, 25)
    expect(segments.flat().map(item => item.id)).toEqual(blocks.map(item => item.id))
    expect(segments.length).toBeGreaterThan(1)
  })

  it('单块超过预算时仍单独成段，不产生空段或丢失内容', () => {
    const huge = block(1, 'x'.repeat(100))
    const segments = segmentBlocks([huge], 10)
    expect(segments).toHaveLength(1)
    expect(segments[0]![0]!.text.length).toBe(100)
  })
})
