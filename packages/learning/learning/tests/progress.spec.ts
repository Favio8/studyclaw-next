/**
 * Progress board + SM-2 + heatmap suite: 9-column round-trip, due records,
 * scheduling math, and history aggregation.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProgressBoard,
  saveProgressBoard,
  upsertProgressRecord,
  dueRecords,
  reviewSchedule,
  updateEf,
} from '@studyclaw/course-builder'
import { heatmap } from '../src/index.ts'

const BOARD_TEXT = [
  '# 学习进度',
  '',
  '- **总体掌握度**：40%',
  '- **待复习卡片数**：1',
  '- **最后更新时间**：2026-08-20 10:00',
  '',
  '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
  '|---|---|---|---|---|---|---|---|---|',
  '| `c_1` | 重载与覆写 | 多态 | 🟡 40% | 2 | 50% | 2.50 | 2026-08-20 | none |',
  '',
].join('\n')

describe('progress board', () => {
  it('loads, updates, and round-trips the 9-column contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-progress-'))
    const path = join(root, 'progress.md')
    await writeFile(path, BOARD_TEXT, 'utf8')
    const board = await loadProgressBoard(path)
    expect(board.overallMastery).toBeCloseTo(0.4)
    expect(board.dueCount).toBe(1)
    expect(board.concepts).toHaveLength(1)
    expect(board.concepts[0]!.conceptId).toBe('c_1')
    expect(board.concepts[0]!.mastery).toBeCloseTo(0.4)
    expect(board.concepts[0]!.ef).toBeCloseTo(2.5)

    const updated = upsertProgressRecord(board, {
      conceptId: 'c_1', name: '重载与覆写', chapter: '多态', mastery: 0.7, evals: 3,
      passRate: 0.67, ef: 2.6, nextReviewAt: '2026-08-30', misattribution: '无',
    })
    await saveProgressBoard(path, updated)
    const reloaded = await loadProgressBoard(path)
    expect(reloaded.concepts[0]!.mastery).toBeCloseTo(0.7)
    expect(reloaded.concepts[0]!.evals).toBe(3)
    await rm(root, { recursive: true, force: true })
  })

  it('dueRecords matches next_review_at against today', () => {
    const board = {
      overallMastery: 0, dueCount: 0, lastUpdatedAt: null,
      concepts: [
        { conceptId: 'a', name: 'A', chapter: '', mastery: 0, evals: 0, passRate: 0, ef: 2.5, nextReviewAt: '2026-08-20', misattribution: 'none' },
        { conceptId: 'b', name: 'B', chapter: '', mastery: 0, evals: 0, passRate: 0, ef: 2.5, nextReviewAt: '2026-09-01', misattribution: 'none' },
      ],
    }
    expect(dueRecords(board, '2026-08-21').map(record => record.conceptId)).toEqual(['a'])
  })

  it('SM-2: pass grows the interval, fail resets it', () => {
    expect(updateEf(2.5, 5)).toBeCloseTo(2.6)
    const pass = reviewSchedule(2.5, 1, 0.9)
    expect(pass.repetitions).toBe(2)
    // FL-29：对齐经典 SM-2 序列，I(2)=6（旧实现为 3）。
    expect(pass.intervalDays).toBe(6)
    const fail = reviewSchedule(2.5, 5, 0.1)
    expect(fail.repetitions).toBe(0)
    expect(fail.intervalDays).toBe(1)
  })
})

describe('heatmap metrics', () => {
  it('aggregates chat/eval/weak-cleared per day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-metrics-'))
    const ws = join(root, 'ws')
    // P1-7：历史目录与写入侧一致，位于 <工作区根>/.studyclaw/history。
    const historyDir = join(ws, '.studyclaw', 'history')
    await mkdir(historyDir, { recursive: true })
    // F-13：行内 ts 为 ISO（UTC），分桶按本地时区归日——夹具用正午 UTC
    // 保证在任何时区都落在"今天"。
    const today = new Date()
    const iso = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12)).toISOString()
    await writeFile(join(historyDir, 'session_20260821-100000.jsonl'), [
      JSON.stringify({ type: 'session_meta', title: '', mode: 'socratic', created_at: iso }),
      JSON.stringify({ type: 'chat', ts: iso, role: 'user', content: 'hi' }),
      JSON.stringify({ type: 'eval', ts: iso, task_id: 't_1', concept_id: 'c_1', passed: false }),
      JSON.stringify({ type: 'eval', ts: iso, task_id: 't_1', concept_id: 'c_1', passed: true }),
    ].join('\n'), 'utf8')
    const payload = await heatmap(ws, 1)
    const day = payload.days[payload.days.length - 1]!
    expect(day.chatTurns).toBe(1)
    expect(day.tasks).toBe(2)
    expect(day.weakSpotsCleared).toBe(1)
    expect(payload.streak.current).toBe(1)
    await rm(root, { recursive: true, force: true })
  })
})
