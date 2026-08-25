/**
 * `studyclaw review` 命令测试：due-only 语义（mode=review）、默认 count 50、
 * REVIEW 头部、到期清空提示、非法 count 用法错误。
 */

import { describe, expect, it } from 'vitest'
import { UsageError } from '../src/lib/args.ts'
import { reviewCommand } from '../src/commands/review.ts'
import { runQuiz } from '../src/commands/quiz.ts'
import { capture, evalStreamFactory, fakeRpc, SINGLE_WORKSPACE, testTerminal } from './helpers.ts'

describe('review', () => {
  it('runQuiz mode=review：REVIEW 头部 + 到期模式拉题', async () => {
    const capturedQuizPayload: Record<string, unknown> = {}
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': (payload) => {
        Object.assign(capturedQuizPayload, payload as Record<string, unknown>)
        return { tasks: [{ taskId: 't_009', conceptId: 'c_x', type: 'concept', difficulty: 3, question: '复习题', options: null }] }
      },
    }
    const cap = capture()
    const evalFake = evalStreamFactory([
      { event: 'scan', data: { phase: 'rubric' } },
      { event: 'rubric', data: { index: 0, criterion: '要点', hit: true } },
      { event: 'result', data: { score: 1, passed: true, feedback: '', misconceptions: [] } },
      { event: 'sm2', data: { ef: 2.0, efNew: 2.1, nextReviewAt: '2026-08-27T00:00:00.000Z', masteryDelta: 0.1 } },
      { event: 'done', data: { taskId: 't_009' } },
    ])
    await runQuiz(
      { rpc: fakeRpc(handlers), evalStream: evalFake.stream, terminal: testTerminal(['答案'], cap) },
      { mode: 'review', count: 50, headline: 'REVIEW' },
    )
    expect(cap.text()).toContain('STUDYCLAW // REVIEW')
    expect(capturedQuizPayload.mode).toBe('review')
    expect(capturedQuizPayload.count).toBe(50)
    expect(cap.text()).toContain('Q1/1')
  })

  it('到期队列清空：黄牌提示（不做 new 补位）', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [] }),
    }
    const cap = capture()
    await runQuiz(
      { rpc: fakeRpc(handlers), evalStream: evalStreamFactory().stream, terminal: testTerminal([], cap) },
      { mode: 'review', count: 50, headline: 'REVIEW' },
    )
    expect(cap.text()).toContain('今日到期队列已清空')
  })

  it('非法 count：UsageError（不触网）', async () => {
    await expect(reviewCommand(['0'])).rejects.toBeInstanceOf(UsageError)
    await expect(reviewCommand(['101'])).rejects.toBeInstanceOf(UsageError)
  })
})
