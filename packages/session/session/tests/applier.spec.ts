/**
 * H5 回归：SyncApplier 更新概念行后必须重算表头汇总（总体掌握度/待复习
 * 卡片数/最后更新时间）——旧实现把 MASTERY_RE 替换回捕获原值（no-op），
 * 汇总停留在上一次全量保存的状态；掌握度单元格还需与 renderMastery 同
 * emoji 口径（L9）。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SyncApplier } from '../src/applier.ts'

async function seedBoard(boardPath: string): Promise<void> {
  await writeFile(boardPath, [
    '# 学习进度', '',
    '- **总体掌握度**：45%', '- **待复习卡片数**：0', '- **最后更新时间**：2026-08-20 10:00', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| c_1 | 重载与覆写 | 继承 | 🟡 70% | 1 | 100% | 2.50 | 2020-01-01 | none | 1 |',
    '| c_2 | 封装 | 继承 | 🔴 20% | 0 | 0% | 2.50 | - | none | 0 |', '',
  ].join('\n'), 'utf8')
}

describe('SyncApplier', () => {
  it('更新概念行后重算表头汇总并写 emoji 单元格（H5/L9）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-applier-'))
    const courseDir = join(root, 'course')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    const boardPath = join(courseDir, '.studyclaw', 'progress.md')
    await seedBoard(boardPath)
    const applier = new SyncApplier(courseDir, courseDir)
    const summary = await applier.apply(
      { concept_updates: [{ id: 'c_1', score: 1 }], memory_hints: [] },
      new Date(),
    )
    expect(summary).toHaveLength(1)
    const text = await readFile(boardPath, 'utf8')
    // 行更新为 emoji 口径单元格。
    expect(text).toContain('🟢 100%')
    // 汇总重算：(100% + 20%) / 2 = 60%；c_1 到期（2020-01-01）计 1。
    expect(text).toContain('- **总体掌握度**：60%')
    expect(text).toContain('- **待复习卡片数**：1')
    // 最后更新时间不再是 fixture 里的旧值。
    expect(text).not.toContain('2026-08-20 10:00')
    await rm(root, { recursive: true, force: true })
  })

  it('转义单元格行不错位（F-11 家族）：名字含 \\| 的行 mastery 仍正确回写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-applier-esc-'))
    const courseDir = join(root, 'course')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    const boardPath = join(courseDir, '.studyclaw', 'progress.md')
    await writeFile(boardPath, [
      '# 学习进度', '',
      '- **总体掌握度**：0%', '- **待复习卡片数**：0', '- **最后更新时间**：2026-08-20 10:00', '',
      '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| c_1 | A \\| B | 继承 | 🔴 10% | 0 | 0% | 2.50 | - | none | 0 |', '',
    ].join('\n'), 'utf8')
    const applier = new SyncApplier(courseDir, courseDir)
    await applier.apply({ concept_updates: [{ id: 'c_1', score: 0.5 }], memory_hints: [] }, new Date())
    const text = await readFile(boardPath, 'utf8')
    expect(text).toContain('🟡 50%')
    // 转义序列被还原后再回写，列数保持完整（misattribution 列不缺位）。
    expect(text).toContain('| c_1 | A \\| B | 继承 |')
    await rm(root, { recursive: true, force: true })
  })

  it('RV-12：串行 apply 不丢更新、不留临时文件（宿主经 courseLock 串行的生产形态）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-applier-serial-'))
    const courseDir = join(root, 'course')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    const boardPath = join(courseDir, '.studyclaw', 'progress.md')
    await seedBoard(boardPath)
    const applier = new SyncApplier(courseDir, courseDir)
    // 生产形态：宿主给 TutorSession 注入 withCourseLock，两个 sync 写段串行
    // （锁外并发会被陈旧全量写覆盖，正是 RV-12；固定 tmp 名在并发下还会混合
    // 内容/rename ENOENT）。这里按串行语义驱动两次完整 RMW。
    await applier.apply({ concept_updates: [{ id: 'c_1', score: 1 }], memory_hints: [] }, new Date())
    await applier.apply({ concept_updates: [{ id: 'c_2', score: 0.5 }], memory_hints: [] }, new Date())
    const text = await readFile(boardPath, 'utf8')
    // 两次更新都在（无丢失、无损坏）。
    const c1Row = text.split(/\r?\n/).find(line => line.includes('| c_1 |'))
    const c2Row = text.split(/\r?\n/).find(line => line.includes('| c_2 |'))
    expect(c1Row).toContain('🟢 100%')
    expect(c2Row).toContain('🟡 50%')
    // 无临时文件残留。
    const files = await readdir(join(courseDir, '.studyclaw'))
    expect(files.some(file => file.includes('.tmp'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})
