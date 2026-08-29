/**
 * chatStream 课程校验回归：courseId 非法/与工作区不匹配时必须产出 error 帧
 * 而不是抛异常——SSE 场景下生成器 throw 会穿透宿主 HTTP 层（SSE 头已发时
 * writeHead 兜底会以 ERR_HTTP_HEADERS_SENT 打崩整个 host 进程）。
 */

import { describe, expect, it } from 'vitest'
import { chatStream } from '../src/service.ts'

describe('chatStream 课程校验', () => {
  it('courseId 与工作区 basename 不匹配 → 单条 error 帧，不抛异常', async () => {
    const events: Array<{ kind: string; code?: string }> = []
    for await (const event of chatStream(
      'D:/definitely/not/a/workspace',
      'some-course',
      { message: 'hi', mode: 'socratic' },
      null,
    )) {
      events.push(event as { kind: string; code?: string })
    }
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('error')
    expect(events[0].code).toBe('COURSE_NOT_FOUND')
  })

  it('非法 courseId（路径穿越/点开头）同样转 error 帧', async () => {
    for (const bad of ['../evil', '.hidden', 'a/b']) {
      const events: Array<{ kind: string; code?: string }> = []
      for await (const event of chatStream('D:/root', bad, { message: 'hi' }, null)) {
        events.push(event as { kind: string; code?: string })
      }
      expect(events, `courseId=${bad}`).toHaveLength(1)
      expect(events[0].code, `courseId=${bad}`).toBe('COURSE_NOT_FOUND')
    }
  })
})
