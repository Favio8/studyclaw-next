/**
 * M2 闭环回归：复习时回带原文划线，但**评测提示词里不得出现划线内容**。
 *
 * 这是本项最关键的不变量：划线一旦进入 judge 提示词，用户就能照抄原文作答，
 * 评测失真、掌握度与 SM-2 排期随之失真——整个学习闭环的数据基础被污染。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { createCourseService } from '../src/course.ts'
import { createServer } from 'node:http'
import type { ResolvedChatConfig } from '../src/config.ts'
import { DEFAULT_PARSE_OPTIONS } from '@studyclaw/course-builder'

const SECRET_QUOTE = '绝对机密原文XYZ不得进入评测提示词'

function task(): HarnessTask {
  return {
    task_id: 't_1',
    concept_id: 'c_1',
    source_ref: null,
    type: 'concept',
    difficulty: 2,
    question: '请解释该概念。',
    // MCQ + answer_index：走本地快判，零 LLM 调用——既让本用例不依赖模型
    // 配置，也能证明评测链路完全不读取划线（它根本没有读取的机会）。
    options: ['要点甲', '要点乙'],
    answer_index: 0,
    answer_rationale: null,
    evaluation_criteria: {
      rubric: ['答出要点一', '答出要点二'],
      keywords: ['要点'],
      misattribution_options: ['概念混淆', '无'],
    },
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
  }
}

async function setup(): Promise<{
  ws: string
  service: ReturnType<typeof createCourseService>
  courseId: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-hint-leak-'))
  const ws = join(root, 'ws')
  await mkdir(ws, { recursive: true })
  const sourcePath = join(root, 'doc.md')
  await writeFile(sourcePath, '# 资料\n\n正文。', 'utf8')
  const service = createCourseService(async () => null)
  const created = await service.createCourse(ws, 'ws', [sourcePath])
  await writeTaskPool(ws, [task()])
  await mkdir(join(ws, '.studyclaw'), { recursive: true })
  await writeFile(join(ws, '.studyclaw', 'annotations.json'), JSON.stringify({
    version: 1,
    sources: {
      'doc.md': {
        progress: { page: 1, percent: 0, updatedAt: '' },
        highlights: [{
          id: 'h1', page: 1, rects: [],
          quote: { text: SECRET_QUOTE, prefix: '前文', suffix: '后文' },
          color: 'yellow', comment: '', tags: [], conceptId: 'c_1',
          createdAt: '2026-10-01T00:00:00.000Z',
        }],
      },
    },
  }), 'utf8')
  return { ws, service, courseId: created.course, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('M2：划线只进 UI，不进评测', () => {
  it('主观题经过真实 HTTP 模型适配器，判题请求不包含 UI 划线', async () => {
    const { ws, courseId, cleanup } = await setup()
    const requests: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        requests.push(body)
        const verdict = JSON.stringify({
          judgements: [{ criterion: '答出要点一', hit: true }, { criterion: '答出要点二', hit: true }],
          feedback: '正确', misconceptions: [], misattribution: '无',
        })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ id: 'judge', object: 'chat.completion.chunk', model: 'judge', choices: [{ index: 0, delta: { content: verdict }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as { port: number }
      const config: ResolvedChatConfig = {
        providerId: 'test', model: 'judge', baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: null, apiKey: 'test-key', temperature: 0, maxConcurrency: 1,
        defaultMode: 'socratic', parse: DEFAULT_PARSE_OPTIONS,
      }
      const service = createCourseService(async () => config)
      await writeTaskPool(ws, [{ ...task(), options: null, answer_index: null }])
      const views = await service.quiz(ws, courseId, 'review', 5, null, false)
      expect(JSON.stringify(views)).toContain(SECRET_QUOTE)
      const frames: Array<Record<string, unknown>> = []
      for await (const frame of service.evalSubmit(ws, courseId, 't_1', '学生自己的回答', null)) frames.push(frame)
      expect(frames.at(-1)?.['event']).toBe('done')
      expect(frames.some(frame => frame['event'] === 'rubric')).toBe(true)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain('学生自己的回答')
      expect(requests[0]).toContain('答出要点一')
      expect(requests[0]).not.toContain(SECRET_QUOTE)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await cleanup()
    }
  })
  it('复习取题带回 hints，且字段只属于题面视图', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    const tasks = await service.quiz(ws, courseId, 'review', 5, null, false)
    const view = tasks.find(item => item['taskId'] === 't_1')!
    const hints = view['hints'] as Array<{ text: string; source: string; page: number }>
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({ text: SECRET_QUOTE, source: 'doc.md', page: 1 })
    // rubric / keywords 仍不下发（既有"零泄题"约定未被破坏）。
    expect(view['evaluation_criteria']).toBeUndefined()
    await cleanup()
  })

  it('新卡模式不下发 hints——首次学习不该先看答案性线索', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    const tasks = await service.quiz(ws, courseId, 'new', 5, null, false)
    for (const view of tasks) expect(view['hints']).toBeUndefined()
    await cleanup()
  })

  it('评测链路完全不接触划线：取题带 hints，评测产物零原文', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    // 先确认这条题确实带着划线线索——否则"评测无泄漏"就是伪通过。
    const tasks = await service.quiz(ws, courseId, 'review', 5, null, false)
    expect((tasks.find(item => item['taskId'] === 't_1')!['hints'] as unknown[]).length).toBeGreaterThan(0)

    const frames: Array<{ event: string; data: unknown }> = []
    for await (const frame of service.evalSubmit(ws, courseId, 't_1', '要点甲', null)) {
      frames.push(frame as { event: string; data: unknown })
    }
    expect(JSON.stringify(frames)).not.toContain(SECRET_QUOTE)
    // 评测照常完成，闭环没有因为加了划线而中断。
    expect(frames.some(frame => frame.event === 'result')).toBe(true)
    await cleanup()
  })

  it('无标注时整个 hints 字段缺省，不留空数组占位', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    await rm(join(ws, '.studyclaw', 'annotations.json'), { force: true })
    const tasks = await service.quiz(ws, courseId, 'review', 5, null, false)
    for (const view of tasks) {
      expect(view['hints']).toBeUndefined()
      expect('hints' in view).toBe(false)
    }
    await cleanup()
  })
})
