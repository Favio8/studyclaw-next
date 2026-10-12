/**
 * ApprovalQueue.restore 的容错回归。
 *
 * 恢复来自持久化事件日志的审批请求时，日志行可能是旧 schema、被手工编辑过
 * 或写到一半被截断，时间字段未必能 parse。原实现对 createdAt 做了 NaN 兜底，
 * 却对 expiresAt 用错了顺序：先拿原始字符串算出 remaining（NaN 传播成 NaN），
 * 再在兜底分支里 Date.now()+NaN 去 toISOString() —— 直接抛
 * RangeError: Invalid time value。于是任何一条 expiresAt 损坏的记录都会把
 * 重放路径炸掉，而同文件里 createdAt 的同类防护却是有效的。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalQueue } from '../src/index.ts'

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    name: 'write_file',
    policy: 'ask',
    args: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('ApprovalQueue.restore 容错', () => {
  afterEach(() => vi.useRealTimers())

  it('远期审批不能因 Node timer 溢出在 1ms 后错误超时', () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 9, 11)
    vi.setSystemTime(now)
    const queue = new ApprovalQueue()
    const timeout = 2 ** 31 + 1000
    queue.restore(base({ expiresAt: new Date(now + timeout).toISOString() }) as never)
    vi.advanceTimersByTime(1)
    expect(queue.list()).toHaveLength(1)
    vi.advanceTimersByTime(2 ** 31 - 2)
    expect(queue.list()).toHaveLength(1)
    vi.advanceTimersByTime(1001)
    expect(queue.list()).toHaveLength(0)
  })

  it('超长新请求也按实际截止时间超时，分段计时后仍可取消', async () => {
    vi.useFakeTimers()
    const queue = new ApprovalQueue()
    const pending = queue.request({ agentId: 'a', sessionId: 's', name: 'write_file', policy: 'ask', args: {}, timeoutMs: 2 ** 31 + 1000 })
    vi.advanceTimersByTime(2 ** 31 - 1)
    expect(queue.list()).toHaveLength(1)
    queue.resolve(pending.request.id, 'cancel')
    await expect(pending.decision).resolves.toBe('cancel')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expiresAt 损坏时按默认时长兜底，不抛错', () => {
    const queue = new ApprovalQueue()
    for (const bad of ['not-a-date', '', 'NaN', '2026-13-45T99:99:99Z']) {
      expect(() => queue.restore(base({ id: `x-${bad}`, expiresAt: bad }) as never)).not.toThrow()
    }
  })

  it('createdAt 与 expiresAt 同时损坏也不抛错', () => {
    const queue = new ApprovalQueue()
    expect(() => queue.restore(base({ createdAt: '垃圾', expiresAt: '垃圾' }) as never)).not.toThrow()
  })

  it('兜底后的请求仍是可用的 pending，并带合法 ISO 时间', () => {
    const queue = new ApprovalQueue()
    const restored = queue.restore(base({ expiresAt: 'not-a-date' }) as never)
    expect(restored.status).toBe('pending')
    expect(Number.isNaN(Date.parse(restored.expiresAt))).toBe(false)
    expect(Date.parse(restored.expiresAt)).toBeGreaterThan(Date.now())
    expect(queue.list('agent-1')).toHaveLength(1)
  })

  it('损坏的记录仍可被解析与移除（审批不会永久卡死）', () => {
    const queue = new ApprovalQueue()
    queue.restore(base({ expiresAt: 'not-a-date' }) as never)
    expect(() => queue.resolve('approval-1', 'allow')).not.toThrow()
    expect(queue.list('agent-1')).toHaveLength(0)
  })

  it('已过期的有效记录立刻走超时路径，不留悬挂项', () => {
    const queue = new ApprovalQueue()
    queue.restore(base({ expiresAt: '2020-01-01T00:00:00.000Z' }) as never)
    // remaining 被钳到 0，setTimeout(...,0) 会在下一个 tick 触发。
    expect(queue.list('agent-1')).toHaveLength(1)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(queue.list('agent-1')).toHaveLength(0)
        resolve()
      }, 10)
    })
  })

  it('合法记录不受影响', () => {
    const queue = new ApprovalQueue()
    const restored = queue.restore(base() as never)
    expect(restored.expiresAt).toBe('2099-01-01T00:00:00.000Z')
    expect(restored.createdAt).toBe('2026-10-01T00:00:00.000Z')
  })
})
