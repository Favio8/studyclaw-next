/**
 * progress.md 表格契约与 SM-2 调度回归（批次B）：
 * - F-11：单元格转义 `|`/换行、解析容忍列数漂移、非表格行不再截断收集；
 * - F-12：streak 语义（连续成功次数）、EF 上限钳制、间隔封顶；
 * - 旧 9 列文件的向后兼容。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COLUMNS,
  loadProgressBoard,
  saveProgressBoard,
  upsertProgressRecord,
  reviewSchedule,
  updateEf,
  intervalDays,
} from '../src/progress.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeBoardPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-progress-'))
  tmpRoots.push(root)
  return join(root, 'progress.md')
}

function record(overrides: Partial<Parameters<typeof upsertProgressRecord>[1]> = {}): Parameters<typeof upsertProgressRecord>[1] {
  return {
    conceptId: 'c_x', name: '概念X', chapter: '章一', mastery: 0.5, evals: 2,
    passRate: 0.5, streak: 1, ef: 2.4, nextReviewAt: null, misattribution: 'none',
    ...overrides,
  }
}

describe('progress.md 表格契约（F-11）', () => {
  it('名称含 | 与换行的记录往返不丢行、不破坏表格', async () => {
    const path = await makeBoardPath()
    const boardA = upsertProgressRecord({ overallMastery: 0, dueCount: 0, lastUpdatedAt: null, concepts: [] },
      record({ name: '分类|维度（含竖线）', chapter: '第一章\n第二节' }))
    await saveProgressBoard(path, boardA)
    const loaded = await loadProgressBoard(path)
    expect(loaded.concepts).toHaveLength(1)
    expect(loaded.concepts[0]!.name).toBe('分类|维度（含竖线）')
    expect(loaded.concepts[0]!.chapter).toBe('第一章 第二节')
    const text = await readFile(path, 'utf8')
    expect(text.match(/^\|/gm)?.length).toBeGreaterThanOrEqual(3)
  })

  it('表格中间夹一个坏行，其后概念仍被收集（break 改 continue）', async () => {
    const path = await makeBoardPath()
    const lines = [
      '# 学习进度',
      '',
      `- **总体掌握度**：50%`,
      '- **待复习卡片数**：0',
      '- **最后更新时间**：2026-08-27 10:00',
      '',
      `| ${COLUMNS.join(' | ')} |`,
      `|${COLUMNS.map(() => '---').join('|')}|`,
      '| `c_a` | 概念A | 章一 | 🟢 90% | 1 | 100% | 2.50 | - | none | 1 |',
      '这是一行来自讲义的普通文字（旧实现会在此 break）。',
      '| `c_b` | 概念B | 章一 | 🔴 10% | 1 | 0% | 1.80 | - | none | 0 |',
    ]
    await writeFile(path, lines.join('\n'), 'utf8')
    const board = await loadProgressBoard(path)
    expect(board.concepts.map(concept => concept.conceptId)).toEqual(['c_a', 'c_b'])
  })

  it('旧 9 列文件兼容：streak 缺省为 0，列数异常行按 concept_id 兜底', async () => {
    const path = await makeBoardPath()
    const lines = [
      `| ${['concept_id', 'name', 'chapter', 'mastery', 'evals', 'pass_rate', 'ef', 'next_review_at', 'misattribution'].join(' | ')} |`,
      '|---|---|---|---|---|---|---|---|---|',
      '| `c_old` | 旧格式 | 章一 | 🟡 55% | 3 | 66% | 2.30 | 2026-08-30 | none |',
    ]
    await writeFile(path, lines.join('\n'), 'utf8')
    const board = await loadProgressBoard(path)
    expect(board.concepts[0]).toMatchObject({ conceptId: 'c_old', streak: 0 })
  })

  it('T-9：概念名含 concept_id 子串的行 load→save 往返不丢（旧实现读侧跳过 → eval 擦除该行）', async () => {
    const path = await makeBoardPath()
    const lines = [
      '# 学习进度',
      '',
      '- **总体掌握度**：80%',
      '- **待复习卡片数**：0',
      '- **最后更新时间**：2026-09-27 10:00',
      '',
      `| ${COLUMNS.join(' | ')} |`,
      `|${COLUMNS.map(() => '---').join('|')}|`,
      '| `c_meta` | concept_id 字段规范 | 软工 | 🟢 80% | 3 | 100% | 2.50 | 2099-01-01 | none | 2 |',
      '',
      '备注：本章讨论 concept_id 的命名约束（含子串的非表格行也不得被当表头）。',
    ]
    await writeFile(path, lines.join('\n'), 'utf8')
    const loaded = await loadProgressBoard(path)
    expect(loaded.concepts.map(concept => concept.conceptId)).toEqual(['c_meta'])
    expect(loaded.concepts[0]!.name).toBe('concept_id 字段规范')
    // 读后立即存（eval 链路正是 load→upsert→save）：该行必须仍在。
    await saveProgressBoard(path, upsertProgressRecord(loaded, record({ conceptId: 'c_meta', name: 'concept_id 字段规范', chapter: '软工', mastery: 0.8, evals: 4 })))
    const reloaded = await loadProgressBoard(path)
    expect(reloaded.concepts).toHaveLength(1)
    expect(reloaded.concepts[0]).toMatchObject({ conceptId: 'c_meta', evals: 4 })
  })
})

describe('SM-2 调度（F-12）', () => {
  it('streak 才是 repetitions 输入：失败清零后通过，间隔从 1 天重爬', () => {
    // 连续成功 3 次 → 间隔明显拉长。
    const longRun = reviewSchedule(2.5, 3, 0.95)
    expect(longRun.repetitions).toBe(4)
    expect(longRun.intervalDays).toBeGreaterThan(3)
    // 失败清零 → 下次通过 repetitions 从 1 重算，而不是在历史总量上复利。
    const afterFail = reviewSchedule(longRun.ef, 0, 0.95)
    expect(afterFail.repetitions).toBe(1)
    expect(afterFail.intervalDays).toBe(1)
  })

  it('EF 有上限钳制、间隔有 365 天封顶', () => {
    let ef = 2.85
    for (let i = 0; i < 50; i += 1) ef = updateEf(ef, 5)
    expect(ef).toBeLessThanOrEqual(2.9)
    expect(intervalDays(400, 2.9)).toBe(365)
  })

  it('FL-29 回归：间隔序列对齐经典 SM-2（I(1)=1、I(2)=6、I(3)≈15）', () => {
    expect(intervalDays(1, 2.5)).toBe(1)
    expect(intervalDays(2, 2.5)).toBe(6)
    // I(3) = round(6 * 2.5) = 15（经典 SM-2 序列 1/6/15）。
    expect(intervalDays(3, 2.5)).toBe(15)
    // 旧实现 I(2)=3 的回归哨兵：改回半速序列会在此变红。
  })

  it('失败评测的调度结果写入 streak=0（nextReviewAt 隔天）', () => {
    const failed = reviewSchedule(2.5, 2, 0.2)
    expect(failed).toMatchObject({ repetitions: 0, intervalDays: 1 })
  })
})
