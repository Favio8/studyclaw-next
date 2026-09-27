/**
 * H4 回归：loadCourseState 必须正确解析 renderMastery 产物（`🟢 80%`）与
 * pass_rate 列——旧手写解析把 emoji 单元格 Number 成 NaN → 全部概念按 0 报
 * 进系统提示词，passRate 硬编码 0。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCourseState } from '../src/context.ts'

describe('loadCourseState', () => {
  it('解析 emoji 掌握度单元格与 passRate（H4）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-context-'))
    const courseDir = join(root, 'course')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    await writeFile(join(courseDir, '.studyclaw', 'progress.md'), [
      '# 学习进度', '',
      '- **总体掌握度**：50%', '- **待复习卡片数**：1', '- **最后更新时间**：2026-08-20 10:00', '',
      '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| c_1 | 重载与覆写 | 继承 | 🟢 80% | 2 | 75% | 2.50 | 2026-08-25 | none | 1 |',
      '| c_2 | 封装 | 继承 | 🔴 20% | 1 | 0% | 2.50 | - | none | 0 |', '',
    ].join('\n'), 'utf8')
    const state = await loadCourseState(courseDir)
    expect(state.concepts).toHaveLength(2)
    expect(state.concepts[0]).toMatchObject({ conceptId: 'c_1', mastery: 0.8, passRate: 0.75, evals: 2 })
    expect(state.concepts[1]).toMatchObject({ conceptId: 'c_2', mastery: 0.2, passRate: 0 })
    await rm(root, { recursive: true, force: true })
  })
})
