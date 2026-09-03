/**
 * A4（第三轮审查）回归：agentEventToFrame 帧映射契约。
 *
 * 核心：turn/cancelled 必须映射为 error 帧——断线重试 attach 到已取消的
 * turn 时，客户端要收到显式失败（进错误态 + 保留重试入口），不能把半截
 * 回复当成功渲染。
 */

import { describe, expect, it } from 'vitest'
import { agentEventToFrame } from '../src/service.ts'
// H-1 回归：bin.ts 的 queuedEvents 队列消费路径与 ask 幂等重放路径从包入口
// 导入 agentEventToFrame（此前两处内联 if 链缺 turn/cancelled → TURN_CANCELLED，
// 取消回合被 done 帧错误闭环为成功）。此导入锁定入口导出不被删除。
import { agentEventToFrame as agentEventToFrameFromEntry } from '../src/index.ts'
import type { AgentEvent } from '@studyclaw/agent'

function ev(type: string, payload: Record<string, unknown> = {}): AgentEvent {
  return { agentId: 'study-s1', sessionId: 's1', turnId: 't1', type, payload, seq: 1 }
}

describe('agentEventToFrame（A4）', () => {
  it('turn/cancelled → TURN_CANCELLED error 帧（重放不再静默半截）', () => {
    const frame = agentEventToFrame(ev('turn/cancelled', { reason: 'user' }))
    expect(frame).toMatchObject({ kind: 'error', code: 'TURN_CANCELLED' })
  })

  it('turn/error → AGENT_TURN_FAILED error 帧（既有契约不回归）', () => {
    const frame = agentEventToFrame(ev('turn/error', { message: 'boom' }))
    expect(frame).toMatchObject({ kind: 'error', code: 'AGENT_TURN_FAILED', message: 'boom' })
  })

  it('session/meta → meta 帧；assistant/chunk → token；tool/result → tool', () => {
    expect(agentEventToFrame(ev('session/meta', { sessionId: 's1' }))).toMatchObject({ kind: 'meta' })
    expect(agentEventToFrame(ev('assistant/chunk', { delta: 'hi' }))).toMatchObject({ kind: 'token', delta: 'hi' })
    expect(agentEventToFrame(ev('tool/result', { callId: 'c1', name: 'fetch', status: 'done' }))).toMatchObject({ kind: 'tool' })
  })

  it('turn/end / inbox/* → null（不下发）', () => {
    expect(agentEventToFrame(ev('turn/end', { reason: { kind: 'completed' } }))).toBeNull()
    expect(agentEventToFrame(ev('inbox/queued', {}))).toBeNull()
    expect(agentEventToFrame(ev('input/voided', { seq: 3 }))).toBeNull()
  })

  it('H-1：入口（index.ts）导出与内部实现同一且 cancelled 契约可用（bin.ts 队列/answer 路径依赖）', () => {
    expect(agentEventToFrameFromEntry).toBe(agentEventToFrame)
    expect(agentEventToFrameFromEntry(ev('turn/cancelled', { reason: 'user' }))).toMatchObject({ kind: 'error', code: 'TURN_CANCELLED' })
  })
})
