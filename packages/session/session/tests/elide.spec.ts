/**
 * elideInteractiveBlocks: replay-time elision of sc-interactive fence bodies.
 * Raw block HTML/JS trips the lab gateway's `<script>(...)` disconnect bug,
 * so model-facing replay must carry only a placeholder line.
 */

import { elideInteractiveBlocks } from '../src/session.ts'

describe('elideInteractiveBlocks', () => {
  it('replaces a closed block body with a placeholder, keeping surrounding text', () => {
    const content = [
      '看这个演示。',
      '',
      '```sc-interactive',
      '<title>张量加法</title>',
      '<script>(function () { document.write("hi") })()</script>',
      '```',
      '',
      '以上是演示。',
    ].join('\n')
    const out = elideInteractiveBlocks(content)
    expect(out).not.toContain('<script>')
    expect(out).toContain('```sc-interactive')
    expect(out).toContain('[该交互演示块的源码在回放时已被系统省略（张量加法）；需要引用或修改时请重新生成完整块]')
    expect(out).toContain('看这个演示。')
    expect(out).toContain('以上是演示。')
  })

  it('omits the summary when the block has no <title>', () => {
    const content = '```sc-interactive\n<script>(() => {})()</script>\n```'
    const out = elideInteractiveBlocks(content)
    expect(out).toBe('```sc-interactive\n[该交互演示块的源码在回放时已被系统省略；需要引用或修改时请重新生成完整块]\n```')
  })

  it('elides multiple blocks independently', () => {
    const content = [
      '```sc-interactive',
      '<title>甲</title>',
      '```',
      '中间文字',
      '```sc-interactive',
      '<title>乙</title>',
      '```',
    ].join('\n')
    const out = elideInteractiveBlocks(content)
    expect(out).toContain('（甲）')
    expect(out).toContain('（乙）')
    expect(out).toContain('中间文字')
    expect(out.match(/```/g)).toHaveLength(4)
  })

  it('elides an unclosed fence and re-closes it', () => {
    const content = '前言\n```sc-interactive\n<script>(function () {})()</script>'
    const out = elideInteractiveBlocks(content)
    expect(out).not.toContain('<script>')
    expect(out.endsWith('```')).toBe(true)
    expect(out).toContain('前言')
  })

  it('leaves other fenced code blocks untouched', () => {
    const content = '```js\nconst f = () => 1\n```\n\n```python\nprint("<script>")\n```'
    expect(elideInteractiveBlocks(content)).toBe(content)
  })

  it('returns the original string when no interactive fence is present', () => {
    const content = '普通文本，提到 ```sc-interactive 协议但没有成块。'
    expect(elideInteractiveBlocks(content)).toBe(content)
  })

  it('accepts up to three leading spaces before the fence', () => {
    const content = '   ```sc-interactive\n<script>(x => x)()</script>\n   ```'
    const out = elideInteractiveBlocks(content)
    expect(out).not.toContain('<script>')
    expect(out).toContain('已被系统省略')
  })
})
