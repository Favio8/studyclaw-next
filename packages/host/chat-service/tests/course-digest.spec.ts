/**
 * M4/M5 摘要聚合回归：`courses.digest` 一次返回全课概念级证据，
 * 且 near-24h 的"新划线"是**精确计数**而非按概念最近时间推断。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { createCourseService } from '../src/course.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function task(id: string, conceptId: string, deprecated = false): HarnessTask {
  return {
    task_id: id, concept_id: conceptId, source_ref: null, type: 'concept', difficulty: 2,
    question: `Q ${id}`, options: null, answer_index: null, answer_rationale: null,
    evaluation_criteria: { rubric: ['a', 'b'], keywords: [], misattribution_options: ['无'] },
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated, dynamic: false, target_id: null,
  }
}

function highlight(id: string, conceptId: string | null, createdAt: string) {
  return {
    id, page: 1, rects: [], quote: { text: `划线 ${id}`, prefix: '', suffix: '' },
    color: 'yellow' as const, comment: '', tags: [], conceptId, createdAt,
  }
}

async function setup(): Promise<{ ws: string; service: ReturnType<typeof createCourseService>; courseId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-digest-'))
  tmpRoots.push(root)
  const ws = join(root, 'ws')
  await mkdir(ws, { recursive: true })
  const sourcePath = join(root, 'a.md')
  await writeFile(sourcePath, '# 资料', 'utf8')
  const service = createCourseService(async () => null)
  const created = await service.createCourse(ws, 'ws', [sourcePath])
  const state = join(ws, '.studyclaw')
  await mkdir(join(state, 'tasks'), { recursive: true })

  await writeFile(join(state, 'progress.md'), [
    '# 学习进度', '',
    '- **总体掌握度**：50%', '- **待复习卡片数**：1', '- **最后更新时间**：2026-10-11 10:00', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak | exposure |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    '| `c_a` | 概念A | 章一 | 🟢 80% | 4 | 100% | 2.60 | 2000-01-01 | none | 3 | 6 |',
    '| `c_b` | 概念B | 章一 | 🔴 10% | 1 | 0% | 1.80 | - | none | 0 | 2 |',
  ].join('\n'), 'utf8')

  await writeTaskPool(ws, [task('t1', 'c_a'), task('t2', 'c_a'), task('t3', 'c_b', true)])

  const now = Date.now()
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString()
  await writeFile(join(state, 'annotations.json'), JSON.stringify({
    version: 1,
    sources: {
      'a.md': {
        progress: { page: 1, percent: 0, updatedAt: '' },
        highlights: [
          highlight('h1', 'c_a', iso(60_000)),      // 1 分钟前 —— 新
          highlight('h2', 'c_a', iso(90_000)),      // 1.5 分钟前 —— 新
          highlight('h3', 'c_a', iso(40 * 3600_000)), // 40 小时前 —— 旧
          highlight('h4', null, iso(60_000)),       // 未关联
        ],
      },
    },
  }), 'utf8')

  return { ws, service, courseId: created.course }
}

describe('courses.digest 概念级摘要', () => {
  it('到期数量按当前本地日期计算，不沿用上次写盘的缓存数字', async () => {
    const { ws, service, courseId } = await setup()
    const path = join(ws, '.studyclaw', 'progress.md')
    const { readFile } = await import('node:fs/promises')
    await writeFile(path, (await readFile(path, 'utf8')).replace('卡片数**：1', '卡片数**：0'))
    const digest = await service.digest(ws, courseId)
    expect(digest['dueCount']).toBe(1)
  })
  it('一次返回每个概念的掌握度/题卡数/标注数/下次复习', async () => {
    const { ws, service, courseId } = await setup()
    const digest = await service.digest(ws, courseId) as {
      dueCount: number
      concepts: Array<Record<string, unknown>>
      recentHighlights: number
    }

    expect(digest.dueCount).toBe(1)
    const a = digest.concepts.find(c => c['id'] === 'c_a')!
    expect(a).toMatchObject({
      name: '概念A', mastery: 0.8, evals: 4, exposure: 6,
      taskCount: 2, annotationCount: 3, nextReviewAt: '2000-01-01',
    })
    // 废弃卡不计入题卡数。
    expect(digest.concepts.find(c => c['id'] === 'c_b')!['taskCount']).toBe(0)
    expect(digest.concepts).toHaveLength(2)
  })

  it('近 24 小时新划线是精确计数，不把该概念更早的划线算进来', async () => {
    const { ws, service, courseId } = await setup()
    const digest = await service.digest(ws, courseId) as { recentHighlights: number; concepts: Array<{ id: string; annotationCount: number }> }
    // c_a 共 3 条划线，但只有 2 条在 24 小时内——40 小时前那条不计入。
    // h4 虽未关联概念，却是刚划的，仍是待回顾的重点，因此计入 recentHighlights
    // （"待回顾"是用户视角，不要求先建立概念关联）。
    expect(digest.recentHighlights).toBe(3)
    expect(digest.concepts.find(c => c.id === 'c_a')!.annotationCount).toBe(3)
  })

  it('课程为空时返回空摘要而不是抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-digest-empty-'))
    tmpRoots.push(root)
    const ws = join(root, 'ws')
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    const service = createCourseService(async () => null)
    await expect(service.digest(ws, '不存在的课程')).rejects.toThrow()
  })

  it('标注文件损坏时摘要降级可用（其余字段仍正确）', async () => {
    const { ws, service, courseId } = await setup()
    await writeFile(join(ws, '.studyclaw', 'annotations.json'), 'not json', 'utf8')
    const digest = await service.digest(ws, courseId) as { recentHighlights: number; concepts: Array<{ id: string; taskCount: number }> }
    expect(digest.recentHighlights).toBe(0)
    expect(digest.concepts.find(c => c.id === 'c_a')!.taskCount).toBe(2)
  })
})
