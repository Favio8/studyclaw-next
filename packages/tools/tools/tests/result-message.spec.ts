/**
 * F-18 回归：工具结构化结果必须回灌模型（白名单 + 预算截断），而不是
 * 只回一句 summary。
 */

import { describe, expect, it } from 'vitest'
import { ToolResult } from '../src/result.ts'
import { MAX_TOOL_MESSAGE_CHARS } from '../src/specs.ts'

describe('ToolResult.toToolMessage', () => {
  it('read_source 的行内容进入模型消息', () => {
    const result = new ToolResult('success', '已读取 notes.md 1-2 行（共 10 行）', {
      path: 'notes.md',
      totalLines: 10,
      truncated: false,
      lines: [
        { n: 1, text: '第一行内容' },
        { n: 2, text: '第二行内容' },
      ],
    })
    const message = result.toToolMessage()
    expect(message).toContain('已读取')
    expect(message).toContain('第一行内容')
    expect(message).toContain('第二行内容')
  })

  it('非白名单键（如 path/totalLines 等元数据）不进消息体', () => {
    const result = new ToolResult('success', '完成', { path: '/secret/abs/path', totalLines: 999, internalId: 'x' })
    const message = result.toToolMessage()
    expect(message).toBe('完成')
  })

  it('超预算截断并显式标记', () => {
    const longLine = 'A'.repeat(MAX_TOOL_MESSAGE_CHARS + 500)
    const result = new ToolResult('success', '长文件', { lines: [{ n: 1, text: longLine }] })
    const message = result.toToolMessage()
    expect(message.length).toBeLessThanOrEqual(MAX_TOOL_MESSAGE_CHARS + 80)
    expect(message).toContain('[内容超预算已截断')
  })

  it('rejected 结果不带数据体', () => {
    const result = ToolResult.rejected('路径不允许', 'TOOL_INVALID_ARGS')
    expect(result.toToolMessage()).toBe('路径不允许')
  })
})
