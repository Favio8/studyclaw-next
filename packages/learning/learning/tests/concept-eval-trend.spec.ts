/**
 * conceptEvalTrend：eval 审计行扫描（兼容 legacy 顶层行与 events 信封行）、
 * 时间序折叠、limit 截断、连续失败计数、空目录兜底。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { conceptEvalTrend } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function seedHistory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-trend-'))
  tmpRoots.push(root)
  const historyDir = join(root, '.studyclaw', 'history')
  await mkdir(historyDir, { recursive: true })
  // 文件 A：events 信封行（c_1 先错后对）
  await writeFile(join(historyDir, 'session_a.events.jsonl'), [
    JSON.stringify({ seq: 1, ts: '2026-10-01T10:00:00Z', type: 'eval', payload: { task_id: 't1', concept_id: 'c_1', score: 0.2, passed: false, misconceptions: [] } }),
    JSON.stringify({ seq: 2, ts: '2026-10-02T10:00:00Z', type: 'eval', payload: { task_id: 't2', concept_id: 'c_1', score: 0.9, passed: true, misconceptions: [] } }),
    '',
  ].join('\n'), 'utf8')
  // 文件 B：legacy 顶层行 + 另一个概念的记录；文件名字典序在 A 之后但时间更早，
  // 用来验证跨文件必须按 ts 排序而不是按文件名。
  await writeFile(join(historyDir, 'session_b.jsonl'), [
    JSON.stringify({ type: 'eval', ts: '2026-09-30T09:00:00Z', task_id: 't0', concept_id: 'c_1', score: 0.1, passed: false, misconceptions: [] }),
    JSON.stringify({ type: 'eval', ts: '2026-10-04T09:00:00Z', task_id: 't9', concept_id: 'c_2', score: 1, passed: true, misconceptions: [] }),
    '',
  ].join('\n'), 'utf8')
  return root
}

describe('conceptEvalTrend', () => {
  it('合并两种行形态，按时间升序返回并统计连续失败', async () => {
    const root = await seedHistory()
    const trend = await conceptEvalTrend(root, 'c_1', 3)
    expect(trend.conceptId).toBe('c_1')
    expect(trend.total).toBe(3)
    expect(trend.recent.map(r => r.ts)).toEqual([
      '2026-09-30T09:00:00Z',
      '2026-10-01T10:00:00Z',
      '2026-10-02T10:00:00Z',
    ])
    // 最近一次（10-02）通过 → 连续失败 0
    expect(trend.consecutiveFailures).toBe(0)
  })

  it('limit 截断到最近 N 条', async () => {
    const root = await seedHistory()
    const trend = await conceptEvalTrend(root, 'c_1', 1)
    expect(trend.total).toBe(3)
    expect(trend.recent).toHaveLength(1)
    expect(trend.recent[0]?.ts).toBe('2026-10-02T10:00:00Z')
  })

  it('末尾连续失败正确计数（跨文件时间序）', async () => {
    const root = await seedHistory()
    // 追加一条更晚的失败：最近 3 次变为 错/对/错 → 连续失败 1
    const historyDir = join(root, '.studyclaw', 'history')
    await writeFile(join(historyDir, 'session_c.jsonl'),
      JSON.stringify({ seq: 3, ts: '2026-10-05T10:00:00Z', type: 'eval', payload: { task_id: 't3', concept_id: 'c_1', score: 0.3, passed: false, misconceptions: [] } }) + '\n',
      'utf8')
    const trend = await conceptEvalTrend(root, 'c_1', 3)
    expect(trend.total).toBe(4)
    expect(trend.consecutiveFailures).toBe(1)
    expect(trend.recent[trend.recent.length - 1]?.passed).toBe(false)
  })

  it('按概念过滤；无记录概念返回空趋势', async () => {
    const root = await seedHistory()
    const other = await conceptEvalTrend(root, 'c_2', 3)
    expect(other.total).toBe(1)
    expect(other.consecutiveFailures).toBe(0)
    const missing = await conceptEvalTrend(root, 'c_none', 3)
    expect(missing.total).toBe(0)
    expect(missing.recent).toEqual([])
    expect(missing.consecutiveFailures).toBe(0)
  })

  it('无 history 目录时返回空趋势（不抛错）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-trend-empty-'))
    tmpRoots.push(root)
    const trend = await conceptEvalTrend(root, 'c_1', 3)
    expect(trend.total).toBe(0)
    expect(trend.recent).toEqual([])
  })
})
