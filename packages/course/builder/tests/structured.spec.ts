/**
 * extractJsonObject 回归（第四轮对抗性审查 RV-9）：括号深度扫描必须感知
 * 字符串字面量——题目内容含引号内花括号/引号转义时，裸计数会提前判闭合，
 * 切片 JSON.parse 恒败，structuredCall 重试耗尽后整卡构建失败。
 */

import { describe, expect, it } from 'vitest'
import { extractJsonObject } from '../src/structured.ts'

describe('extractJsonObject', () => {
  it('RV-9：字符串内的花括号不破坏深度计数', () => {
    const raw = '{"question":"求证 f(x)={x} 的定义域","answer_index":2}'
    expect(extractJsonObject(raw)).toEqual({ question: '求证 f(x)={x} 的定义域', answer_index: 2 })
  })

  it('RV-9：字符串内的引号转义与嵌套对象', () => {
    const raw = '{"a":"她说：\\"中间}有花括号\\"","b":{"c":"}"}}'
    expect(extractJsonObject(raw)).toEqual({ a: '她说："中间}有花括号"', b: { c: '}' } })
  })

  it('围栏 JSON 与前后散文共存时正常提取', () => {
    const text = '好的，以下是结果：\n```json\n{"tasks":[{"question":"含 } 的题目"}]}\n```\n以上就是输出。'
    const parsed = extractJsonObject(text) as { tasks: Array<{ question: string }> }
    expect(parsed.tasks[0]!.question).toBe('含 } 的题目')
  })

  it('围栏片段损坏时回落全文扫描（RV-9 兜底候选）', () => {
    const text = '```json\n{"broken": tru\n```\n{"ok": true}'
    expect(extractJsonObject(text)).toEqual({ ok: true })
  })

  it('无 JSON 时抛错', () => {
    expect(() => extractJsonObject('抱歉，我无法输出。')).toThrow('未找到合法 JSON')
  })
})
