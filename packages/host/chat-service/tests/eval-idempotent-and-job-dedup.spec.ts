/**
 * UI-7 + UI-8 回归：
 * - UI-7：evalSubmit 按 evalId 幂等——同一作答的重试直接重放已结算帧，
 *   不二次 settle（progress.md 的 evals 计数不膨胀）。
 * - UI-8：JobManager.start 对同课程在途构建去重——并发 /build 复用同一
 *   jobId，不会双跑 LLM 构建。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTaskPool, type HarnessTask } from '@studyclaw/course-builder'
import { createCourseService, JobManager } from '../src/course.ts'
import type { ResolvedChatConfig } from '../src/config.ts'

/** 与 eval-submit.spec.ts 同款：providerId 'mock' 触发 requireGenerator 通过，
 * 但 MCQ 答案键路径零 LLM 调用。 */
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

function mcqTask(): HarnessTask {
  return {
    task_id: 't_mcq_001',
    concept_id: 'c_mcq',
    source_ref: { file: 'doc.md', chunk_id: 'chunk_001' },
    type: 'concept',
    difficulty: 2,
    question: 'Harness 的本质定位是什么？',
    options: ['模型内部的推理模块', '连接模型与真实环境的控制系统', '存储训练数据的数据库', '渲染输出的前端框架'],
    answer_index: 1,
    answer_rationale: 'Harness 是连接模型与真实环境的控制系统。',
    evaluation_criteria: {
      // rubric 遵循 FL-27 schema（min(2).max(4)）：少于 2 条会被加载校验丢弃。
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
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-eval-idem-'))
  const ws = join(root, 'ws')
  await mkdir(ws, { recursive: true })
  const sourcePath = join(root, 'doc.md')
  await writeFile(sourcePath, '# Harness\n\n控制系统。', 'utf8')
  // getConfig 返回 null（与 eval-submit.spec 同款）：createCourse 不启动后台
  // 构建，题卡池夹具不被异步覆盖；evalSubmit 的答案键路径也不需要 LLM。
  const service = createCourseService(async () => null)
  const created = await service.createCourse(ws, 'ws', [sourcePath])
  await writeTaskPool(ws, [mcqTask()])
  return { root, ws, service, courseId: created.course, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** progress.md 是 markdown 表格；取 c_mcq 行的 evals 列（第 5 列）。 */
function evalsOfCmcq(md: string): number {
  const row = md.split("\n").find(line => line.includes('| `c_mcq` |'))
  if (row === undefined) return 0
  return Number(row.split('|').map(cell => cell.trim())[5] ?? 0)
}

async function collect(gen: AsyncGenerator<{ event: string; data: unknown }>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = []
  for await (const frame of gen) frames.push(frame as { event: string; data: Record<string, unknown> })
  return frames
}

describe('UI-7：evalSubmit evalId 幂等', () => {
  it('同一 evalId 的重复提交重放已结算帧，progress.evals 不重复累加', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    const evalId = 'ev_test_eval_001'
    const answer = '连接模型与真实环境的控制系统'

    const first = await collect(service.evalSubmit(ws, courseId, 't_mcq_001', answer, null, evalId))
    expect(first.filter(f => f.event === 'result')).toHaveLength(1)
    expect(first.at(-1)?.event).toBe('done')

    // 第一次 settle 后的 evals 计数。
    const progressPath = join(ws, '.studyclaw', 'progress.md')
    const afterFirst = await readFile(progressPath, 'utf8')
    expect(evalsOfCmcq(afterFirst)).toBe(1)

    // 模拟 SSE 中断后的手动重试：同一 evalId、同一作答。
    const retry = await collect(service.evalSubmit(ws, courseId, 't_mcq_001', answer, null, evalId))
    // 帧序列完整重放（客户端 UI 正常显示结果），但不二次 settle。
    expect(retry.filter(f => f.event === 'result')).toHaveLength(1)
    expect(retry.at(-1)?.event).toBe('done')
    const afterRetry = await readFile(progressPath, 'utf8')
    expect(evalsOfCmcq(afterRetry)).toBe(1)

    // 不同作答 → 新指纹 → 正常评测并计数。
    const other = await collect(service.evalSubmit(ws, courseId, 't_mcq_001', '错误的答案', null, 'ev_test_eval_002'))
    expect(other.filter(f => f.event === 'result')).toHaveLength(1)
    const afterOther = await readFile(progressPath, 'utf8')
    expect(evalsOfCmcq(afterOther)).toBe(2)
    await cleanup()
  })

  it('不携带 evalId 的调用保持旧行为（每次都真实结算）', async () => {
    const { ws, service, courseId, cleanup } = await setup()
    const answer = '连接模型与真实环境的控制系统'
    await collect(service.evalSubmit(ws, courseId, 't_mcq_001', answer, null))
    await collect(service.evalSubmit(ws, courseId, 't_mcq_001', answer, null))
    const progressPath = join(ws, '.studyclaw', 'progress.md')
    const content = await readFile(progressPath, 'utf8')
    expect(evalsOfCmcq(content)).toBe(2)
    await cleanup()
  })
})

describe('UI-8：JobManager 同课程在途构建去重', () => {
  it('同 courseDir 未完成的构建返回现有 jobId；不同 courseDir 各自新建', async () => {
    const jobs = new JobManager()
    const emptyDir = await mkdtemp(join(tmpdir(), 'studyclaw-job-dedup-'))
    try {
      // 合法 config：requireGenerator 通过；空目录构建异步推进，两次 start
      // 之间事件循环未转，job 保持 queued/running → 去重命中。
      const ctx = { workspaceRoot: emptyDir, config: fakeConfig }
      const idA1 = jobs.start(emptyDir, 'courseA', ctx)
      const idA2 = jobs.start(emptyDir, 'courseA', ctx)
      expect(idA2).toBe(idA1)
      const dirB = await mkdtemp(join(tmpdir(), 'studyclaw-job-dedup-'))
      try {
        const idB = jobs.start(dirB, 'courseB', ctx)
        expect(idB).not.toBe(idA1)
      } finally {
        await rm(dirB, { recursive: true, force: true })
      }
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})
