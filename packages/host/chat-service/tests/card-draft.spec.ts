/**
 * P3 划词建卡：cardCommit 的 harnessTask 校验、池内 id 去重与落盘；
 * cardDraft 在未配置模型时给出可读错误（不写任何文件）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadTaskPool, writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { createCourseService } from '../src/course.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function course(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-carddraft-'))
  tmpRoots.push(root)
  const courseDir = join(root, 'demo')
  await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
  await mkdir(join(courseDir, 'sources'), { recursive: true })
  return courseDir
}

function draftTask(taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    concept_id: 'c_ef',
    source_ref: { file: 'reading', chunk_id: 'read_x' },
    type: 'concept',
    difficulty: 2,
    question: 'SM-2 的 EF 钳制区间是什么？',
    options: null,
    evaluation_criteria: { rubric: ['答对钳制区间 [1.3, 2.9]', '说明超出区间的处理'], keywords: ['EF'] },
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
  }
}

describe('cardCommit（P3）', () => {
  it('合法草稿落盘进 tasks/，池内 id 冲突自动改号', async () => {
    const courseDir = await course()
    const existing: HarnessTask = { ...(draftTask('ef_001') as unknown as HarnessTask) }
    await writeTaskPool(courseDir, [existing])
    const service = createCourseService(async () => null)

    const first = await service.cardCommit(courseDir, 'demo', { task: draftTask('ef_001') })
    const second = await service.cardCommit(courseDir, 'demo', { task: draftTask('ef_001') })
    const ids = (first.tasks as Array<{ task_id: string }>).map(t => t.task_id)
      .concat((second.tasks as Array<{ task_id: string }>).map(t => t.task_id))
    expect(ids).toEqual(['ef_001_2', 'ef_001_3'])

    const pool = await loadTaskPool(courseDir)
    expect(pool).toHaveLength(3)
    expect(pool[1]?.question).toContain('EF 钳制区间')
  })

  it('非法草稿（缺 rubric）被 harnessTask 校验拒绝且不写盘', async () => {
    const courseDir = await course()
    const service = createCourseService(async () => null)
    const broken = { ...draftTask('ef_bad'), evaluation_criteria: undefined }
    await expect(service.cardCommit(courseDir, 'demo', { task: broken })).rejects.toThrow(/格式不合法/)
    expect(await loadTaskPool(courseDir)).toEqual([])
  })

  it('cardDraft 未配置模型：可读错误，不产生任何文件', async () => {
    const courseDir = await course()
    const service = createCourseService(async () => null)
    await expect(service.cardDraft(courseDir, 'demo', { content: '选中内容' })).rejects.toThrow(/模型/)
    const files = await readFile(join(courseDir, '.studyclaw', 'tasks.json'), 'utf8').catch(() => '')
    expect(files).toBe('')
  })
})
