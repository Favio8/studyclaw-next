/**
 * T-5 回归：动态卡（generateDynamicCards）与生成批同一道质量闸。
 * - answer_index 缺失/越界：dynamicBatch schema 的 superRefine 在结构化调用期
 *   即拒（对齐 builder models.ts 的 generatedTask）——旧实现动态卡完全绕过该校
 *   验，坏卡入池后 MCQ 快判恒不匹配，永无法通过；
 * - 选项长度失衡：enforceTaskQuality 丢弃（此前动态卡不过质量闸）。
 */

import { describe, expect, it } from 'vitest'
import { generateDynamicCards, type EvaluatorOptions } from '../src/index.ts'
import { harnessTask, type HarnessTask, type StructuredCallClient } from '@studyclaw/course-builder'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 以 _emit_structured 工具调用形态喂一个固定批次的假客户端。 */
class FakeStructuredClient implements StructuredCallClient {
  calls = 0
  constructor(private readonly batch: unknown) {}
  async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls += 1
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'call-1' as never,
      name: '_emit_structured',
      argumentsDelta: JSON.stringify(this.batch),
    }
  }
}

function mcq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'concept',
    difficulty: 2,
    question: '关于重载与覆写，下列说法正确的是？',
    options: ['重载是同名不同参数', '覆写是子类重定义父类方法'],
    answer_index: 1,
    answer_rationale: '覆写发生在父子类之间。',
    evaluation_criteria: { rubric: ['要点一', '要点二'], keywords: ['覆写'], misattribution_options: [] },
    ...overrides,
  }
}

const sourceTask: HarnessTask = harnessTask.parse({
  task_id: 'c_override_001',
  concept_id: 'c_override',
  source_ref: { file: 'a.md', chunk_id: 'chunk_1' },
  type: 'concept',
  difficulty: 2,
  question: '什么是覆写？',
  options: null,
  answer_index: null,
  answer_rationale: null,
  evaluation_criteria: { rubric: ['要点一', '要点二'], keywords: ['覆写'], misattribution_options: [] },
  history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
  deprecated: false,
  dynamic: false,
  target_id: null,
})

const evaluatorOptions: EvaluatorOptions = {
  provider: 'mock',
  model: 'mock-model',
  temperature: 0.3,
  maxRetries: 1,
}

describe('generateDynamicCards 质量闸（T-5）', () => {
  it('answer_index 越界的动态卡在结构化校验期即拒（重试后抛错，不入池）', async () => {
    const client = new FakeStructuredClient({ tasks: [mcq({ answer_index: 9 })] })
    await expect(generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')).rejects.toThrow()
    expect(client.calls).toBe(1)
  })

  it('answer_index 缺失的选择题同样被拒（schema superRefine）', async () => {
    const client = new FakeStructuredClient({ tasks: [mcq({ answer_index: null })] })
    await expect(generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')).rejects.toThrow()
  })

  it('合法动态卡正常返回（动态标记/目标卡指向完整）', async () => {
    const client = new FakeStructuredClient({ tasks: [mcq()] })
    const cards = await generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ dynamic: true, answer_index: 1, concept_id: 'c_override', target_id: 'dynamic:c_override_001' })
  })

  it('选项长度失衡的动态卡被质量闸丢弃（正确项可被猜中，不入池）', async () => {
    const client = new FakeStructuredClient({
      tasks: [mcq({ options: ['短', '这是一个非常长的选项承载全部限定条件以至于长度严重失衡'] })],
    })
    const cards = await generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')
    expect(cards).toHaveLength(0)
  })

  it('T-19：同毫秒连续两批的动态卡 task_id 不碰撞（随机后缀）', async () => {
    const client = new FakeStructuredClient({ tasks: [mcq()] })
    const first = await generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')
    const second = await generateDynamicCards(client, evaluatorOptions, sourceTask, '混淆了重载与覆写')
    expect(first[0]!.task_id).not.toBe(second[0]!.task_id)
    // 仍可溯源到源题与概念。
    expect(first[0]!.concept_id).toBe('c_override')
    expect(first[0]!.target_id).toBe('dynamic:c_override_001')
  })
})
