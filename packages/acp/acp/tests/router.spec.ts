import { describe, expect, it } from 'vitest'
import { AcpRouter, ACP_PROTOCOL_VERSION } from '../src/index.ts'

describe('StudyClaw ACP router', () => {
  it('normalizes initialization and DSH method aliases', async () => {
    const router = new AcpRouter({
      createSession: async params => ({ sessionId: String(params['sessionId'] ?? 'new') }),
    })
    await expect(router.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toMatchObject({ result: { protocolVersion: ACP_PROTOCOL_VERSION } })
    await expect(router.handle({ id: 2, method: 'session.new', params: { sessionId: 's1' } })).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } })
  })

  it('emits session/update notifications for streamed prompts', async () => {
    const updates: unknown[] = []
    const router = new AcpRouter({ prompt: async (_params, emit) => { emit?.({ sessionId: 's1', kind: 'assistant/delta', delta: 'ok' }); return { sessionId: 's1', stopReason: 'end_turn' } } })
    await expect(router.handle({ id: 'p1', method: 'session.prompt', params: { message: 'hi' } }, { emit: notification => updates.push(notification) })).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    expect(updates).toEqual([{ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', kind: 'assistant/delta', delta: 'ok' } }])
  })

  it('returns stable JSON-RPC errors for invalid requests and missing methods', async () => {
    await expect(new AcpRouter({}).handle({ id: 1 })).resolves.toMatchObject({ error: { code: -32600 } })
    await expect(new AcpRouter({}).handle({ id: 1, method: 'unknown' })).resolves.toMatchObject({ error: { code: -32601 } })
  })

  it('routes agent lifecycle aliases and forwards cancellation signals', async () => {
    const calls: string[] = []
    let receivedSignal: AbortSignal | undefined
    const router = new AcpRouter({
      createSession: async params => { calls.push(`create:${String(params['courseId'])}`); return { agentId: 'a1' } },
      cancel: async params => { calls.push(`cancel:${String(params['agentId'])}`); return { phase: 'cancelled' } },
      prompt: async (_params, _emit, signal) => { receivedSignal = signal; return { stopReason: 'cancelled' } },
    })
    await expect(router.handle({ id: 1, method: 'agents.create', params: { courseId: 'c1' } })).resolves.toMatchObject({ result: { agentId: 'a1' } })
    await expect(router.handle({ id: 2, method: 'session.cancel', params: { agentId: 'a1' } })).resolves.toMatchObject({ result: { phase: 'cancelled' } })
    const controller = new AbortController()
    await router.handle({ id: 3, method: 'session.prompt', params: { courseId: 'c1', message: 'hi' } }, { signal: controller.signal })
    expect(calls).toEqual(['create:c1', 'cancel:a1'])
    expect(receivedSignal).toBe(controller.signal)
  })
})
