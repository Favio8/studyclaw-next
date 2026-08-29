/**
 * MCQ 快速判分（答案键全有全无，零 LLM）回归：
 * - 带 answer_index 的选择题：命中 → 满分通过；错选 → 0 分且 feedback 指出正确答案；
 * - 整条 SSE 瞬时完成（不触发任何 LLM 调用）。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { createCourseService } from '../src/course.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

const fakeConfig: ResolvedChatConfig = {
  providerId: 'mock',
  model: 'mock-model',
  reasoningEffort: null,
  judgeModel: null,
  judgeEffort: null,
  baseUrl: 'https://mock.example/v1',
  apiKeyEnv: 'MOCK_API_KEY',
  apiKey: 'sk-mock',
  temperature: 0.3,
  maxConcurrency: 1,
  maxTokens: null,
  defaultMode: 'socratic',
  permissionPreset: 'workspace-write',
  plugins: {},
}

function mcqTask(answerIndex: number): HarnessTask {
  return {
    task_id: 't_mcq_001',
    concept_id: 'c_mcq',
    source_ref: { file: 'doc.md', chunk_id: 'chunk_001' },
    type: 'concept',
    difficulty: 2,
    question: 'Harness 的本质定位是什么？',
    options: [
      '模型内部的推理模块',
      '连接模型与真实环境的控制系统',
      '存储训练数据的数据库',
      '渲染输出的前端框架',
    ],
    answer_index: answerIndex,
    answer_rationale: 'Harness 是连接模型与真实环境的控制系统。',
    evaluation_criteria: {
      rubric: ['能指出 Harness 是连接模型与真实环境的控制系统', '能说明其把模型意图转化为可控操作'],
      keywords: ['控制系统'],
      misattribution_options: ['概念混淆', '推导漏洞', '边界遗漏', '无'],
    },
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
  }
}

async function setup(): Promise<{ root: string; ws: string; service: ReturnType<typeof createCourseService>; courseId: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-eval-fast-'))
  const ws = join(root, 'ws')
  await mkdir(ws, { recursive: true })
  const sourcePath = join(root, 'doc.md')
  await writeFile(sourcePath, '# Harness\n\n控制系统。', 'utf8')
  const service = createCourseService(async () => null)
  const created = await service.createCourse(ws, 'ws', [sourcePath])
  await writeTaskPool(ws, [mcqTask(1)])
  return { root, ws, service, courseId: created.course, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function collect(gen: AsyncGenerator<{ event: string; data: unknown }>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = []
  for await (const frame of gen) frames.push(frame as { event: string; data: Record<string, unknown> })
  return frames
}

describe('evalSubmit MCQ answer-key fast grading', () => {
  it('选对：满分通过；FL-27 约定答案键路径不再伪造 rubric 帧', async () => {
    const { root, ws, service, courseId, cleanup } = await setup()
    const frames = await collect(service.evalSubmit(ws, courseId, 't_mcq_001', '连接模型与真实环境的控制系统', null))
    const result = frames.find(frame => frame.event === 'result')
    expect(result?.data).toMatchObject({ score: 1, passed: true })
    // FL-27：答案键是"单一布尔"判分，把它伪装成逐采分点命中帧会让多采分点
    // 的诊断价值归零——MCQ 快判只发结论（result/sm2/done），不发 rubric 帧。
    const rubrics = frames.filter(frame => frame.event === 'rubric')
    expect(rubrics).toHaveLength(0)
    expect(frames.at(-1)?.event).toBe('done')
    await cleanup()
  })

  it('选错：0 分待巩固，feedback 指出正确答案与解析', async () => {
    const { root, ws, service, courseId, cleanup } = await setup()
    const frames = await collect(service.evalSubmit(ws, courseId, 't_mcq_001', '存储训练数据的数据库', null))
    const result = frames.find(frame => frame.event === 'result')
    expect(result?.data).toMatchObject({ score: 0, passed: false })
    const rubrics = frames.filter(frame => frame.event === 'rubric')
    expect(rubrics).toHaveLength(0)
    expect(String(result?.data.feedback)).toContain('正确答案')
    expect(String(result?.data.feedback)).toContain('连接模型与真实环境的控制系统')
    await cleanup()
  })
})
