/**
 * 题卡质量闸与生成规格轮换回归（题卡质量 A 档）：
 * - checkTaskQuality/enforceTaskQuality：答案键缺失/越界、选项长度失衡、同概念近似重复；
 * - generationTargets：type/difficulty/答案位三轮换，修掉"全池只有难度 2/4"；
 * - answerPositionSkewWarning：位置偏斜告警。
 */

import { describe, expect, it } from 'vitest'
import type { HarnessTask } from './models.ts'
import { answerPositionSkewWarning, enforceTaskQuality } from '../src/quality.ts'
import { generationTargets } from '../src/task-gen.ts'

function mcq(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    task_id: 't_001',
    concept_id: 'c_x',
    source_ref: null,
    type: 'concept',
    difficulty: 3,
    question: 'Harness 的本质定位是什么？',
    options: [
      '模型内部的推理模块，负责生成 token',
      '连接模型与真实环境的控制系统，转化模型意图',
      '存储训练数据与权重的数据库系统',
      '渲染模型输出界面的前端组件',
    ],
    answer_index: 1,
    answer_rationale: null,
    evaluation_criteria: {
      rubric: ['要点一', '要点二'],
      keywords: [],
      misattribution_options: ['概念混淆', '推导漏洞', '边界遗漏', '无'],
    },
    history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
    ...overrides,
  }
}

describe('enforceTaskQuality', () => {
  it('合格卡通过并统计答案位置分布', () => {
    const gate = enforceTaskQuality([mcq(), mcq({ task_id: 't_002', question: 'queryLoop 与底层 API client 的关系是？', answer_index: 0 })])
    expect(gate.kept).toHaveLength(2)
    expect(gate.dropped).toHaveLength(0)
    expect(gate.answerPositionHistogram).toEqual({ 0: 1, 1: 1 })
  })

  it('选择题缺 answer_index → 丢弃', () => {
    const gate = enforceTaskQuality([mcq({ answer_index: null })])
    expect(gate.kept).toHaveLength(0)
    expect(gate.dropped[0]!.reason).toContain('缺少 answer_index')
  })

  it('answer_index 越界 → 丢弃', () => {
    const gate = enforceTaskQuality([mcq({ answer_index: 9 })])
    expect(gate.dropped[0]!.reason).toContain('越界')
  })

  it('选项长度失衡（最长/最短 > 2.5x）→ 丢弃', () => {
    const gate = enforceTaskQuality([mcq({
      options: ['错', '连接模型与真实环境的控制系统，把模型的意图转化为可控、可观察、可审计的实际操作，并负责记录审计日志'.repeat(1), '错二', '错三'],
    })])
    expect(gate.dropped[0]!.reason).toContain('长度失衡')
  })

  it('同概念题干归一化后完全一致 → 后到者丢弃', () => {
    const gate = enforceTaskQuality([
      mcq(),
      mcq({ task_id: 't_dup', question: 'Harness 的本质定位是什么' }),
    ])
    expect(gate.kept).toHaveLength(1)
    expect(gate.dropped[0]!.reason).toContain('完全一致')
  })

  it('仅差序号的系列题（问题1/问题2）不误杀', () => {
    const gate = enforceTaskQuality([
      mcq(),
      mcq({ task_id: 't_seq', question: 'Harness 的本质定位是什么？（第 2 问）' }),
    ])
    expect(gate.kept).toHaveLength(2)
  })

  it('开放题（无 options）不适用 MCQ 规则', () => {
    const open = mcq({ options: null, answer_index: null })
    const gate = enforceTaskQuality([open])
    expect(gate.kept).toHaveLength(1)
  })
})

describe('answerPositionSkewWarning', () => {
  it('单一位置超 60% 触发告警，样本不足不告警', () => {
    expect(answerPositionSkewWarning({ 0: 4, 1: 1 })).toContain('偏斜')
    expect(answerPositionSkewWarning({ 0: 2, 1: 2 })).toBeNull()
    expect(answerPositionSkewWarning({ 0: 1 })).toBeNull()
  })
})

describe('generationTargets', () => {
  it('type/difficulty/答案位按轮换表推进，5 张覆盖 5 档难度', () => {
    const targets = generationTargets(5, 0)
    expect(targets.map(target => target.difficulty)).toEqual([1, 3, 5, 2, 4])
    expect(targets.map(target => target.type)).toEqual(['concept', 'scenario', 'debug_edge', 'concept', 'scenario'])
    expect(targets.map(target => target.answerPosition)).toEqual([0, 2, 1, 3, 0])
  })

  it('offset 使相邻批次的规格错开', () => {
    const [first, second] = [generationTargets(2, 0), generationTargets(2, 2)]
    expect(first[0]!.difficulty).not.toBe(second[0]!.difficulty)
  })
})
