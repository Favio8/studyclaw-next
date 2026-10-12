/**
 * F2 概念补题：只读覆盖统计（有效题卡判定、缺题清单、前置条件）与共享失败分类。
 *
 * 这些状态决定右栏入口的文案与是否发送注定失败的请求，是补题闭环最易回归的一层。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { conceptCardStatus, isSharedModelProblem } from '../src/concept-cards.ts'

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

async function setupCourse(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-cfill-'))
  tmpRoots.push(root)
  const state = join(root, '.studyclaw')
  await mkdir(join(state, 'tasks'), { recursive: true })
  await writeFile(join(state, 'syllabus.json'), JSON.stringify({
    course_id: 'ws',
    title: '测试课程',
    version: '1.0.0',
    granularity: 'fine',
    concept_origin: 'semantic',
    chapters: [{
      id: 'chap_1',
      title: '第一章',
      description: '',
      dependencies: [],
      concepts: [
        { id: 'c_1', name: '已覆盖概念', type: 'mechanism', prerequisites: [], mastery_score: 0 },
        { id: 'c_2', name: '只有废弃卡', type: 'mechanism', prerequisites: [], mastery_score: 0 },
        { id: 'c_3', name: '完全缺题', type: 'mechanism', prerequisites: [], mastery_score: 0 },
      ],
    }],
    adjacency: {},
  }), 'utf8')
  return root
}

describe('conceptCardStatus', () => {
  it('覆盖数与缺题清单只计有效题卡，废弃卡不算覆盖', async () => {
    const root = await setupCourse()
    await writeTaskPool(root, [task('t1', 'c_1'), task('t2', 'c_1'), task('t3', 'c_2', true)])
    const status = await conceptCardStatus(root, true)
    expect(status.conceptOrigin).toBe('semantic')
    expect(status.totalConcepts).toBe(3)
    expect(status.coveredConcepts).toBe(1)
    expect(status.missingConcepts).toBe(2)
    expect(status.missing.map(item => item.id).sort()).toEqual(['c_2', 'c_3'])
    expect(status.concepts.find(item => item.conceptId === 'c_2')?.cardCount).toBe(0)
    expect(status.concepts.find(item => item.conceptId === 'c_1')?.cardCount).toBe(2)
  })

  it('没有模型时间接入口仍返回覆盖统计，但标记 modelReady=false', async () => {
    const root = await setupCourse()
    await writeTaskPool(root, [])
    const status = await conceptCardStatus(root, false)
    expect(status.modelReady).toBe(false)
    expect(status.missingConcepts).toBe(3)
  })

  it('大纲为手动章节时 conceptOrigin 为 headings（前端据此要求先确认概念）', async () => {
    const root = await setupCourse()
    const path = join(root, '.studyclaw', 'syllabus.json')
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete raw.concept_origin
    await writeFile(path, JSON.stringify(raw), 'utf8')
    await writeTaskPool(root, [])
    const status = await conceptCardStatus(root, true)
    expect(status.conceptOrigin).toBe('headings')
  })
})

describe('isSharedModelProblem', () => {
  it('认证/额度/端点不可用判定为共享问题（暂停后续概念）', () => {
    expect(isSharedModelProblem('缺少 API Key：请在 设置 → 模型配置 中为当前供应商填写密钥')).toBe(true)
    expect(isSharedModelProblem('端点返回 HTTP 429: rate limit')).toBe(true)
    expect(isSharedModelProblem('无法连接模型端点: ECONNREFUSED')).toBe(true)
    expect(isSharedModelProblem('模型不可用: deepseek-chat')).toBe(true)
  })

  it('单概念问题（依据过期）不是共享问题，应继续其他概念', () => {
    expect(isSharedModelProblem('概念依据已过期，请重新提炼')).toBe(false)
    expect(isSharedModelProblem('模型未生成符合题卡契约的卡片')).toBe(false)
  })
})
