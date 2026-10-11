/**
 * ACP stdio 传输：请求必须并发处理，否则取消不可用。
 *
 * 回归的场景：`session.prompt` 长时间在途时，随后到达的 `session.cancel`
 * 被串行读循环压在缓冲里，直到 prompt 自己结束才发出——尽管宿主 HTTP 层
 * 按请求 id 存了 abort controller、且 initialize 声明了 cancellation 能力。
 * 表现就是卡住的回合只能杀进程。
 *
 * 这里用一个「慢 prompt」桩复现：prompt 在 gate 上等待，只有收到 cancel
 * 才会放行。若传输是串行的，cancel 永远送不到，测试超时。
 */

import { describe, expect, it } from 'vitest'
import { runAcpStdio } from '../src/lib/acp-stdio.ts'

async function* fromArray(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    // 让出事件循环，模拟真实 stdin 的逐行到达。
    await Promise.resolve()
    yield line
  }
}

describe('runAcpStdio', () => {
  it('长 prompt 在途时，cancel 仍被并发送出', async () => {
    let markCancelled = () => {}
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve })

    const written: string[] = []
    const started: string[] = []

    const run = runAcpStdio({
      lines: fromArray([
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.prompt', params: { text: 'hi' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session.cancel', params: {} }),
      ]),
      write: (text) => { written.push(text) },
      send: async (request) => {
        started.push(request.method ?? '')
        if (request.method === 'session.prompt') {
          // 等到取消真的送达才放行——串行实现下这里会死锁。
          await cancelled
          return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { aborted: true } })
        }
        markCancelled()
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { cancelled: true } })
      },
    })

    // prompt 未被取消则整体超时：串行传输下 cancel 排在 prompt 之后，永远发不出。
    await expect(Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel never reached the host')), 2000)),
    ])).resolves.toBeUndefined()

    expect(started).toContain('session.cancel')
    expect(written.join('')).toContain('"aborted":true')
  })

  it('每次写出一整行，响应不互相穿插', async () => {
    const written: string[] = []
    // 让不同请求以不同顺序完成，制造乱序。
    await runAcpStdio({
      lines: fromArray([
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'fast' }),
      ]),
      write: (text) => { written.push(text) },
      send: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, request.method === 'slow' ? 30 : 1))
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method })
      },
    })

    expect(written).toHaveLength(2)
    for (const line of written) {
      expect(line.endsWith('\n')).toBe(true)
      // 每一行都是独立可解析的 JSON——没有半行拼接。
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('坏行产出 JSON-RPC 错误且不中断后续请求', async () => {
    const written: string[] = []
    await runAcpStdio({
      lines: fromArray([
        '{ this is not json',
        JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' }),
        '',
      ]),
      write: (text) => { written.push(text) },
      send: async (request) => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }),
    })

    const parsed = written.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed.some((p) => p['error'] !== undefined)).toBe(true)
    expect(parsed.some((p) => p['result'] === 'ok')).toBe(true)
  })

  it('在途请求数不超过上限', async () => {
    let peak = 0
    let current = 0
    const lines = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ jsonrpc: '2.0', id: i, method: 'work' }))

    await runAcpStdio({
      lines: fromArray(lines),
      maxInFlight: 3,
      write: () => {},
      send: async () => {
        current += 1
        peak = Math.max(peak, current)
        await new Promise((resolve) => setTimeout(resolve, 5))
        current -= 1
        return '{"ok":true}'
      },
    })

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('空行被忽略', async () => {
    const sent: string[] = []
    await runAcpStdio({
      lines: fromArray(['', '   ', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })]),
      write: () => {},
      send: async (request) => { sent.push(request.method ?? ''); return '{"ok":true}' },
    })
    expect(sent).toEqual(['initialize'])
  })
})