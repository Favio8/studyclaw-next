/**
 * Streaming splitter behavior suite (ports the Python test_session splitter
 * cases): arbitrary chunk sizes never leak markers, passthrough stays pure,
 * malformed sync is silent, schema-violating sync throws.
 */

import { extractSync, parseFull, streamSplit } from '../src/splitter.ts'
import { SYNC_MARKER } from '../src/splitter.ts'
import { SessionError } from '../src/store.ts'

// 夹具形态对齐 Python test_session._full_reply：think 在前、可见正文在后、
// sync 结尾（该形态在任意切块粒度下都不触发尾保区截断语义）。
const PREFACE = '我们先看 Filter 阶段。你觉得没有任何节点通过 Filter 时会发生什么？'
const FULL_REPLY = [
  '<think>首先思考：学生对多态的理解在接口层。',
  '结论：派生类必须实现抽象方法。',
  '</think>',
  PREFACE,
  '所以正确写法是覆写。',
  SYNC_MARKER,
  '{"_studyclaw_sync": {"concept_updates": [{"id": "c_1", "score": 0.6}], "memory_hints": ["再次混淆重载与覆写"], "changelog": "+ 攻克抽象类"}}',
  '',
].join('')

const VISIBLE = `${PREFACE}所以正确写法是覆写。`
const THINK = '首先思考：学生对多态的理解在接口层。结论：派生类必须实现抽象方法。'

describe('streamSplit', () => {
  it('arbitrary chunk sizes never leak markers and emit exactly one sync event', () => {
    for (const chunkSize of [1, 2, 3, 7, 13, 1000]) {
      const chunks: string[] = []
      for (let i = 0; i < FULL_REPLY.length; i += chunkSize) chunks.push(FULL_REPLY.slice(i, i + chunkSize))
      const events = [...streamSplit(chunks)]
      const text = events.filter(e => e.kind === 'text').map(e => e.delta).join('')
      const thought = events.filter(e => e.kind === 'think').map(e => e.delta).join('')
      const syncCount = events.filter(e => e.kind === 'sync').length
      expect(text).toBe(VISIBLE)
      expect(text).not.toContain('<think>')
      expect(text).not.toContain('</think>')
      expect(text).not.toContain(SYNC_MARKER)
      expect(thought).toBe(THINK)
      expect(syncCount).toBe(1)
    }
  })

  it('passthrough of a marker-free stream is a pure text sequence', () => {
    const raw = '先说结论 A。再给例子 B。最后提醒边界 C。'
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += 4) chunks.push(raw.slice(i, i + 4))
    const events = [...streamSplit(chunks)]
    expect(events.filter(e => e.kind === 'text').map(e => e.delta).join('')).toBe(raw)
    expect(events.every(e => e.kind === 'text')).toBe(true)
  })

  it('parseFull separates think and sync', () => {
    const parsed = parseFull(FULL_REPLY)
    expect(parsed.visible).toBe(VISIBLE)
    expect(parsed.thinks).toEqual([THINK])
    expect(parsed.syncRaw).toEqual({
      concept_updates: [{ id: 'c_1', score: 0.6 }],
      memory_hints: ['再次混淆重载与覆写'],
      changelog: '+ 攻克抽象类',
    })
  })

  it('malformed sync payload is silently dropped; schema violations throw', () => {
    const [visible, payload] = extractSync(`正文。${SYNC_MARKER}\n{broken`)
    expect(visible).toBe('正文。')
    expect(payload).toBeNull()

    const bad = `正文。${SYNC_MARKER}${JSON.stringify({ _studyclaw_sync: { concept_updates: [{ id: 'c_x', score: 5 }] } })}`
    expect(() => extractSync(bad)).toThrow(SessionError)
  })

  it('sync content after the marker never reaches the visible stream', () => {
    const raw = `前文。${SYNC_MARKER}{"_studyclaw_sync":{"concept_updates":[],"memory_hints":[]}}\n尾巴也屏蔽`
    const events = [...streamSplit([raw])]
    const text = events.filter(e => e.kind === 'text').map(e => e.delta).join('')
    expect(text).toBe('前文。')
  })
})
