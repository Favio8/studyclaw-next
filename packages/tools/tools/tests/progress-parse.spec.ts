/**
 * get_course_state 进度表解析回归（对抗性审查发现的三处隐患）：
 * 1. F-11 转义：名字/章节含 `\|` 的行此前裸 split('|') 整行错位；
 * 2. 列序：next_review_at 此前读成 misattribution 列（差一列），到期判定恒错；
 * 3. 掌握度：`🟢 80%` 直接 Number → NaN → 全部概念按 0 处理，weak 列表恒错。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handlerGetCourseState, type ToolContext } from '../src/handlers.ts'

const courseDir = await mkdtemp(join(tmpdir(), 'studyclaw-progress-'))
await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
// 内容模拟 builder renderRecordRow 的写侧产物（escapeCell 转义 + renderMastery emoji）。
await writeFile(join(courseDir, '.studyclaw', 'progress.md'), [
  '# 学习进度',
  '',
  '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| `c_pipe` | 管\\|道名 | 第一章\\|第二节 | 🟢 80% | 3 | 100% | 2.50 | 2020-01-01 | none | 2 |',
  '| `c_ok` | 普通名 | 第二章 | 🔴 10% | 1 | 0% | 2.50 | - | none | 0 |',
  '| `c_due` | 待复习 | 第三章 | 🟡 50% | 2 | 50% | 2.30 | 2020-01-02 | none | 1 |',
  '',
  '备注段落（非表格行之后解析必须继续）',
  '| `c_after` | 备注后行 | 第四章 | 🟢 90% | 4 | 100% | 2.60 | 2099-01-01 | none | 3 |',
  '',
].join('\n'), 'utf8')

afterAll(() => rm(courseDir, { recursive: true, force: true }))

const ctx: ToolContext = { courseDir, workspaceRoot: courseDir }

describe('get_course_state 进度表解析', () => {
  it('F-11 转义列对齐、next_review_at 列序正确、emoji 掌握度可解析', async () => {
    const [, data] = await handlerGetCourseState(ctx, {})
    const view = data as { mastery: Record<string, number>; dueIds: string[]; weakIds: string[]; dueCount: number }
    // 四行全部解析（含备注段之后的行），`\|` 没有破坏列对齐。
    expect(Object.keys(view.mastery)).toEqual(['c_pipe', 'c_ok', 'c_due', 'c_after'])
    expect(view.mastery['c_pipe']).toBe(0.8)
    expect(view.mastery['c_after']).toBe(0.9)
    // 2020 年到期；'-' 未排期与 2099 未到期都不算。
    expect(view.dueIds).toEqual(['c_pipe', 'c_due'])
    expect(view.dueCount).toBe(2)
    // mastery<0.4 仅 c_ok；旧实现 NaN→0 时这里会是全部概念。
    expect(view.weakIds).toEqual(['c_ok'])
  })
})
