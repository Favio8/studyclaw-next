/**
 * 项目即课程判定（文件夹即项目即课程）：项目根持有 syllabus.json 时才是一
 * 门课（单元素 courses）；未初始化项目返回空列表（供打开即初始化）；
 * 目录不存在/非目录返回 missing。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listCourseSummaries } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function projectDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-summary-'))
  tmpRoots.push(root)
  const dir = join(root, 'harness')
  await mkdir(join(dir, 'history'), { recursive: true })
  return dir
}

describe('listCourseSummaries (project = one course)', () => {
  it('已初始化项目：单课程摘要（id=basename、标题/掌握度/到期/lastActive）', async () => {
    const dir = await projectDir()
    await writeFile(join(dir, 'syllabus.json'), JSON.stringify({ course_id: basename(dir), title: 'Harness 讲义', version: '1.0.0' }), 'utf8')
    await writeFile(join(dir, 'progress.md'), [
      '# 学习进度', '',
      '- **总体掌握度**：42%', '- **待复习卡片数**：3', '- **最后更新时间**：2026-08-20 10:00', '',
      '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
      '|---|---|---|---|---|---|---|---|---|',
      '| c_1 | 概念 | 章 | 40% | 1 | 50% | 2.5 | 2026-08-25 | none |', '',
    ].join('\n'), 'utf8')
    await writeFile(join(dir, 'history', 'session_20260901-100000.jsonl'), '{}\n', 'utf8')

    const result = await listCourseSummaries(dir)
    expect(result.missing).toBe(false)
    expect(result.courses).toHaveLength(1)
    const course = result.courses[0]!
    expect(course.id).toBe(basename(dir))
    expect(course.title).toBe('Harness 讲义')
    expect(course.overallMastery).toBeCloseTo(0.42)
    expect(course.dueToday).toBe(3)
    expect(course.lastActiveAt).not.toBeNull()
  })

  it('未初始化项目（无 syllabus）：courses 为空、missing=false（触发打开即初始化）', async () => {
    const dir = await projectDir()
    const result = await listCourseSummaries(dir)
    expect(result).toEqual({ courses: [], missing: false })
  })

  it('目录不存在：missing=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-summary-missing-'))
    tmpRoots.push(root)
    const result = await listCourseSummaries(join(root, 'gone'))
    expect(result).toEqual({ courses: [], missing: true })
  })
})
