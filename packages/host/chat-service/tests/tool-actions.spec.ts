import { describe, expect, it } from 'vitest'
import { createToolActions } from '../src/service.ts'
import type { CourseService } from '../src/course.ts'

const ctx = {
  courseDir: '/tmp/studyclaw/courses/demo',
  workspaceRoot: '/tmp/studyclaw',
}

async function* evalFrames(): AsyncGenerator<Record<string, unknown>> {
  yield { event: 'scan', data: { phase: 'rubric' } }
  yield { event: 'result', data: { score: 0.9, passed: true, feedback: '继续说明边界条件。', rubric_hits: { secret: true } } }
  yield { event: 'sm2', data: { ef: 2.5 } }
  yield { event: 'done', data: { taskId: 'task_1' } }
}

function fakeCourseService(): CourseService {
  return {
    taskPool: async () => [{ taskId: 'task_1', conceptId: 'c_1', type: 'qa', difficulty: 2 }],
    createCards: async () => ({ tasks: [{ task_id: 'task_new', concept_id: 'c_1', type: 'qa', difficulty: 1, answer: 'secret' }] }),
    dynamicCards: async () => ({ tasks: [{ task_id: 'dynamic_1', concept_id: 'c_1', type: 'qa', difficulty: 3, rubric: 'secret' }] }),
    quiz: async () => [{ taskId: 'task_1', conceptId: 'c_1', type: 'qa', difficulty: 2, question: '题面', options: null }],
    evalSubmit: () => evalFrames(),
  } as unknown as CourseService
}

describe('createToolActions', () => {
  it('projects generated cards to metadata only', async () => {
    const actions = createToolActions(fakeCourseService())
    const created = await actions.createCard(ctx, { content: '内容' })
    const dynamic = await actions.generateDynamicCard(ctx, { taskId: 'task_1', misconception: '误区' })
    expect(created[1]).toEqual({ tasks: [{ taskId: 'task_new', conceptId: 'c_1', type: 'qa', difficulty: 1 }] })
    expect(dynamic[1]).toEqual({ tasks: [{ taskId: 'dynamic_1', conceptId: 'c_1', type: 'qa', difficulty: 3 }] })
  })

  it('collects eval result without returning rubric details', async () => {
    const actions = createToolActions(fakeCourseService())
    const result = await actions.evaluateAnswer(ctx, { taskId: 'task_1', answer: '作答' })
    expect(result[1]).toEqual({ passed: true, score: 0.9, feedback: '继续说明边界条件。' })
    expect(JSON.stringify(result[1])).not.toContain('secret')
  })

  it('returns task-pool distributions without individual card payloads', async () => {
    const actions = createToolActions(fakeCourseService())
    const result = await actions.getTaskPool(ctx, {})
    expect(result[1]).toEqual({
      count: 1,
      conceptId: null,
      byType: { qa: 1 },
      byDifficulty: { '2': 1 },
      byConcept: { c_1: 1 },
    })
    expect(JSON.stringify(result[1])).not.toContain('task_1')
    expect(JSON.stringify(result[1])).not.toContain('题面')
  })
})
