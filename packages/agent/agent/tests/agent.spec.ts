import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Agent, ApprovalQueue } from '../src/index.ts'
import { SessionEventStore, utcTs } from '@studyclaw/session'

async function setup(): Promise<{ root: string; agent: Agent }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-'))
  const events = new SessionEventStore(join(root, 'history'))
  const agent = new Agent({
    agentId: 'agent-1',
    sessionId: '20260822-120000',
    events,
    runner: async function* (input, context) {
      yield { type: 'assistant/chunk', payload: { content: `echo:${input.content}` } }
      if (input.content === 'wait') {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1000)
          context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
      yield { type: 'assistant/message', payload: { content: `done:${input.content}` } }
    },
  })
  return { root, agent }
}

describe('Agent runtime', () => {
  it('keeps approval requests durable until explicit resolution', async () => {
    const queue = new ApprovalQueue()
    const pending = queue.request({ agentId: 'a', sessionId: 's', name: 'write_file', policy: 'write', args: { path: 'x' }, timeoutMs: 1000 })
    expect(queue.list('a')[0]?.status).toBe('pending')
    expect(queue.resolve(pending.request.id, 'deny').status).toBe('deny')
    await expect(pending.decision).resolves.toBe('deny')
    expect(queue.list('a')).toEqual([])
  })

  it('rehydrates an approval request idempotently after a host restart', async () => {
    const queue = new ApprovalQueue()
    const input = {
      id: 'approval-restored',
      agentId: 'a',
      sessionId: 's',
      name: 'write_file',
      policy: 'write',
      args: { path: 'x' },
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }
    expect(queue.restore(input)).toMatchObject({ id: input.id, status: 'pending' })
    expect(queue.restore(input)).toMatchObject({ id: input.id, status: 'pending' })
    expect(queue.list('a')).toHaveLength(1)
    expect(queue.resolve(input.id, 'allow').status).toBe('allow')
  })

  it('emits one durable-resolution callback for timeout and explicit decisions', async () => {
    const queue = new ApprovalQueue()
    const resolved: Array<{ id: string; decision: string }> = []
    queue.onResolved((request, decision) => { resolved.push({ id: request.id, decision }) })
    const timeout = queue.request({ agentId: 'a', sessionId: 's', name: 'run_command', policy: 'action', args: {}, timeoutMs: 5 })
    await timeout.decision
    expect(resolved).toEqual([{ id: timeout.request.id, decision: 'timeout' }])
    const denied = queue.request({ agentId: 'a', sessionId: 's', name: 'write_file', policy: 'write', args: {}, timeoutMs: 1000 })
    queue.resolve(denied.request.id, 'deny')
    await denied.decision
    expect(resolved.at(-1)).toEqual({ id: denied.request.id, decision: 'deny' })
  })

  it('queues turns, persists ordered events, and projects messages', async () => {
    const { root, agent } = await setup()
    const first = agent.send({ content: 'one' })
    const second = agent.send({ content: 'two' })
    const firstEvents = []
    for await (const event of first.events) firstEvents.push(event.type)
    const secondEvents = []
    for await (const event of second.events) secondEvents.push(event.type)
    await agent.whenIdle()
    expect(firstEvents).toEqual(['assistant/chunk', 'assistant/message'])
    expect(secondEvents).toEqual(['assistant/chunk', 'assistant/message'])
    const projection = await agent.projection()
    expect(projection.messages.map(message => message.content)).toEqual(['one', 'done:one', 'two', 'done:two'])
    expect((await agent.options.events.load(agent.options.sessionId)).filter(row => row.type === 'turn/end').map(row => row.payload['reason'])).toEqual([
      { kind: 'completed' },
      { kind: 'completed' },
    ])
    expect(projection.lastSeq).toBeGreaterThan(0)
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('exposes a durable parent relation in the live status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-parent-'))
    const events = new SessionEventStore(join(root, 'history'))
    const agent = new Agent({
      agentId: 'child-agent',
      sessionId: 'child-session',
      parentAgentId: 'parent-agent',
      events,
      runner: async function* () {},
    })
    expect(agent.status).toMatchObject({ agentId: 'child-agent', parentAgentId: 'parent-agent' })
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('cancels active work and records a cancellation event', async () => {
    const { root, agent } = await setup()
    const turn = agent.send({ content: 'wait' })
    await new Promise(resolve => setTimeout(resolve, 10))
    agent.cancel()
    const events = []
    for await (const event of turn.events) events.push(event.type)
    await agent.whenIdle()
    expect(events).toContain('turn/cancelled')
    expect((await agent.projection()).phase).toBe('cancelled')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('persists an interrupted assistant prefix and structured abort cause', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-interrupted-'))
    const events = new SessionEventStore(join(root, 'history'))
    const agent = new Agent({
      agentId: 'interrupted-agent',
      sessionId: 'interrupted-session',
      events,
      runner: async function* (_input, context) {
        yield { type: 'assistant/chunk', payload: { delta: 'partial answer' } }
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    })
    const handle = agent.send({ content: 'interrupt me' })
    const iterator = handle.events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'assistant/chunk' } })
    agent.cancel({ cause: 'user' })
    const seen: string[] = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) seen.push(event.type)
    await agent.whenIdle()
    const rows = await events.load('interrupted-session')
    expect(seen).toContain('assistant/message')
    expect(rows.find(row => row.type === 'assistant/message' && row.payload['interrupted'] === true)?.payload['content']).toBe('partial answer')
    expect(rows.findLast(row => row.type === 'turn/end')?.payload['reason']).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect((await agent.projection()).messages.at(-1)).toMatchObject({ content: 'partial answer', interrupted: true })
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('records structured UNKNOWN failures while keeping the stream error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-error-'))
    const events = new SessionEventStore(join(root, 'history'))
    const agent = new Agent({
      agentId: 'error-agent',
      sessionId: 'error-session',
      events,
      runner: async function* () { throw new Error('boom') },
    })
    const handle = agent.send({ content: 'fail me' })
    await expect((async () => { for await (const _event of handle.events) { /* drain */ } })()).rejects.toThrow('boom')
    const row = (await events.load('error-session')).findLast(item => item.type === 'turn/end')
    expect(row?.payload['reason']).toEqual({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('voids the user input of a failed turn that produced no visible output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-void-'))
    const events = new SessionEventStore(join(root, 'history'))
    let attempts = 0
    const agent = new Agent({
      agentId: 'void-agent',
      sessionId: 'void-session',
      events,
      runner: async function* () {
        attempts += 1
        if (attempts === 1) throw new Error('gateway gone')
        yield { type: 'assistant/message', payload: { content: 'done:will fail' } }
      },
    })
    const handle = agent.send({ content: 'will fail' })
    await expect((async () => { for await (const _event of handle.events) { /* drain */ } })()).rejects.toThrow('gateway gone')
    await agent.whenIdle()
    // 零输出的失败回合：用户输入被补偿剔除，投影不再保留它。
    await expect(agent.projection().then(p => p.messages)).resolves.toEqual([])
    const rows = await events.load('void-session')
    expect(rows.filter(row => row.type === 'input/voided')).toHaveLength(1)
    expect(rows.find(row => row.type === 'user/input')?.payload['content']).toBe('will fail')
    // 重发同一消息后只出现一条用户消息，不再残留重复行。
    const retry = agent.send({ content: 'will fail' })
    for await (const _event of retry.events) { /* drain */ }
    await agent.whenIdle()
    await expect(agent.projection().then(p => p.messages.map(message => [message.role, message.content])))
      .resolves.toEqual([['user', 'will fail'], ['assistant', 'done:will fail']])
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the user input visible when a failed turn already produced output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-void-kept-'))
    const events = new SessionEventStore(join(root, 'history'))
    const agent = new Agent({
      agentId: 'void-kept-agent',
      sessionId: 'void-kept-session',
      events,
      runner: async function* () {
        yield { type: 'assistant/message', payload: { content: 'partial answer' } }
        throw new Error('died mid-turn')
      },
    })
    const handle = agent.send({ content: 'explain X' })
    await expect((async () => { for await (const _event of handle.events) { /* drain */ } })()).rejects.toThrow('died mid-turn')
    await agent.whenIdle()
    const projection = await agent.projection()
    expect(projection.messages.map(message => [message.role, message.content])).toEqual([['user', 'explain X'], ['assistant', 'partial answer']])
    expect((await events.load('void-kept-session')).some(row => row.type === 'input/voided')).toBe(false)
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('supports next-step steering, wake latch, and stable idle convergence', async () => {
    const { root, agent } = await setup()
    const first = agent.send({ content: 'wait' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const steered = agent.steer({ content: 'steer' })
    agent.cancel({ keepInbox: true })
    await agent.whenIdle()
    const firstEvents: string[] = []
    for await (const event of first.events) firstEvents.push(event.type)
    const steeredEvents: string[] = []
    for await (const event of steered.events) steeredEvents.push(event.type)
    const rows = await agent.options.events.load(agent.options.sessionId)
    expect(rows.filter(row => row.type === 'turn/start').map(row => row.payload['target'])).toEqual(['next-turn', 'next-step'])
    expect(firstEvents).toContain('turn/cancelled')
    expect(steeredEvents).toContain('assistant/message')
    expect(agent.status.phase).toBe('idle')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps admitted steering inside the active turn as a second step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-steering-'))
    const events = new SessionEventStore(join(root, 'history'))
    let agent!: Agent
    const seen: string[] = []
    agent = new Agent({
      agentId: 'steering-agent',
      sessionId: 'steering-session',
      events,
      runner: async function* (input) {
        seen.push(input.content)
        if (input.content === 'first') {
          // Give the caller a deterministic window to admit a next-step item.
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        yield { type: 'assistant/message', payload: { content: `done:${input.content}` } }
      },
    })
    const first = agent.send({ content: 'first' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const steered = agent.steer({ content: 'steer' })
    const firstEvents: string[] = []
    for await (const event of first.events) firstEvents.push(event.type)
    const steeringEvents: string[] = []
    for await (const event of steered.events) steeringEvents.push(event.type)
    await agent.whenIdle()
    const rows = await events.load('steering-session')
    expect(seen).toEqual(['first', 'steer'])
    expect(rows.filter(row => row.type === 'turn/start')).toHaveLength(1)
    expect(rows.filter(row => row.type === 'step/start')).toHaveLength(2)
    expect(rows.filter(row => row.type === 'user/input').map(row => row.payload['content'])).toEqual(['first', 'steer'])
    expect(firstEvents).toContain('assistant/message')
    expect(steeringEvents).toContain('assistant/message')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('does not replay an admitted steering item after host recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-steering-recovery-'))
    const events = new SessionEventStore(join(root, 'history'))
    await events.append('steering-recovery-session',
      { ts: utcTs(), type: 'inbox/queued', payload: { turnId: 'steer-1', target: 'next-step', content: 'already handled' } },
      { ts: utcTs(), type: 'inbox/dequeued', payload: { turnId: 'steer-1', target: 'next-step', content: 'already handled' } },
      { ts: utcTs(), type: 'inbox/admitted', payload: { turnId: 'steer-1', target: 'next-step', parentTurnId: 'turn-1' } },
    )
    const agent = new Agent({
      agentId: 'steering-recovery-agent',
      sessionId: 'steering-recovery-session',
      events,
      runner: async function* () { yield { type: 'assistant/message', payload: { content: 'unexpected' } } },
    })
    await agent.restore()
    expect(agent.status.queued).toBe(0)
    expect(agent.status.phase).toBe('idle')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('supports durable inbox prepend, replace, remove and clear operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-inbox-api-'))
    const events = new SessionEventStore(join(root, 'history'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seen: string[] = []
    const agent = new Agent({
      agentId: 'inbox-api-agent',
      sessionId: 'inbox-api-session',
      events,
      runner: async function* (input) {
        seen.push(input.content)
        yield { type: 'assistant/message', payload: { content: input.content } }
      },
    })
    const maintenance = agent.runMaintenance(async () => gate)
    const removed = agent.inbox.append('next-turn', { content: 'removed' })
    const replaced = agent.inbox.append('next-turn', { content: 'old' })
    expect(agent.inbox.replace(replaced.turnId, { content: 'new' })).toBe(true)
    const prepended = agent.inbox.prepend('next-turn', { content: 'first' })
    expect(agent.inbox.remove(removed.turnId)).toBe(true)
    release()
    await maintenance
    await Promise.all([
      (async () => { for await (const _event of prepended.events) { /* drain */ } })(),
      (async () => { for await (const _event of replaced.events) { /* drain */ } })(),
    ])
    await agent.whenIdle()
    expect(seen).toEqual(['first', 'new'])
    const rows = await events.load('inbox-api-session')
    expect(rows.some(row => row.type === 'inbox/replaced')).toBe(true)
    expect(rows.some(row => row.type === 'inbox/dropped' && row.payload['reason'] === 'removed')).toBe(true)
    expect(agent.inbox.hasPending).toBe(false)
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('retries a failed runner through the Host retry policy before erroring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-retry-'))
    const events = new SessionEventStore(join(root, 'history'))
    let attempts = 0
    const agent = new Agent({
      agentId: 'retry-agent',
      sessionId: '20260822-120001',
      events,
      retryDelayMs: 0,
      retry: async (_error, attempt) => attempt < 1,
      runner: async function* () {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        yield { type: 'assistant/message', payload: { content: 'ok' } }
      },
    })
    const handle = agent.send({ content: 'retry me' })
    const seen: string[] = []
    for await (const event of handle.events) seen.push(event.type)
    expect(attempts).toBe(2)
    expect(seen).toEqual(['assistant/message'])
    expect((await events.load('20260822-120001')).filter(row => row.type === 'request/retry')).toHaveLength(1)
    expect((await agent.projection()).phase).toBe('idle')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('cancels a retry backoff without replaying user input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-retry-cancel-'))
    const events = new SessionEventStore(join(root, 'history'))
    let attempts = 0
    let retryStarted!: () => void
    const retryStartedPromise = new Promise<void>(resolve => { retryStarted = resolve })
    const agent = new Agent({
      agentId: 'retry-cancel-agent',
      sessionId: '20260822-120003',
      events,
      retryDelayMs: 500,
      retry: async () => { retryStarted(); return true },
      runner: async function* () {
        attempts += 1
        throw new Error('transient')
      },
    })
    agent.send({ content: 'retry then cancel' })
    await retryStartedPromise
    await new Promise(resolve => setTimeout(resolve, 5))
    agent.cancel()
    await agent.whenIdle()
    const rows = await events.load('20260822-120003')
    expect(attempts).toBe(1)
    expect(rows.filter(row => row.type === 'user/input')).toHaveLength(1)
    expect(rows.filter(row => row.type === 'request/retry')).toHaveLength(1)
    expect(rows.some(row => row.type === 'turn/cancelled')).toBe(true)
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('converges dispose after an abort-aware runner and gates maintenance on idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-maintenance-'))
    const events = new SessionEventStore(join(root, 'history'))
    const agent = new Agent({
      agentId: 'maintenance-agent',
      sessionId: '20260822-120004',
      events,
      runner: async function* (_input, context) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 100)
          context.signal.addEventListener('abort', () => { clearTimeout(timer); setTimeout(resolve, 5) }, { once: true })
        })
        if (context.signal.aborted) return
        yield { type: 'assistant/message', payload: { content: 'done' } }
      },
    })
    agent.send({ content: 'busy' })
    await expect(agent.runMaintenance(async () => 'never')).rejects.toThrow('不空闲')
    agent.cancel()
    await agent.whenIdle()
    await expect(agent.runMaintenance(async () => 'ok')).resolves.toBe('ok')
    agent.send({ content: 'dispose' })
    await agent.dispose()
    expect(agent.status.phase).toBe('disposed')
    await rm(root, { recursive: true, force: true })
  })

  it('restores waiting state from durable ask/approval projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-restore-'))
    const events = new SessionEventStore(join(root, 'history'))
    await events.append('20260822-120002',
      { ts: utcTs(), type: 'ask/pending', payload: { question: '继续吗？' } },
      { ts: utcTs(), type: 'approval/pending', payload: { requestId: 'a1', name: 'write_file', policy: 'write', args: {} } },
    )
    const agent = new Agent({ agentId: 'restore-agent', sessionId: '20260822-120002', events, runner: async function* () {} })
    await agent.restore()
    expect(agent.status.phase).toBe('waiting')
    agent.cancel()
    expect(agent.status.phase).toBe('cancelled')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('persists an inbox turn and rehydrates it after a live agent is replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-inbox-'))
    const events = new SessionEventStore(join(root, 'history'))
    const first = new Agent({ agentId: 'first', sessionId: 'inbox-session', events, runner: async function* () {} })
    first.send({ content: 'survive restart', mode: 'debug', metadata: { source: 'test' } }, 'next-turn', false)
    for (let attempt = 0; attempt < 20 && (await events.load('inbox-session')).length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    const replacement = new Agent({
      agentId: 'replacement',
      sessionId: 'inbox-session',
      events,
      runner: async function* input () { yield { type: 'assistant/message', payload: { content: `replayed:${input}` } } },
    })
    await replacement.restore()
    await replacement.whenIdle()
    const rows = await events.load('inbox-session')
    expect(rows.some(row => row.type === 'inbox/queued')).toBe(true)
    expect(rows.some(row => row.type === 'inbox/dequeued')).toBe(true)
    expect(rows.filter(row => row.type === 'user/input')).toHaveLength(1)
    expect((await replacement.projection()).messages.some(message => message.content.includes('replayed'))).toBe(true)
    first.cancel()
    await first.dispose()
    await replacement.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('records a compaction boundary without rewriting durable history', async () => {
    const { root, agent } = await setup()
    agent.send({ content: 'compact me' })
    await agent.whenIdle()
    const before = (await agent.options.events.load(agent.options.sessionId)).length
    await expect(agent.compact('summary')).resolves.toMatchObject({ kind: 'compaction' })
    const rows = await agent.options.events.load(agent.options.sessionId)
    expect(rows.length).toBeGreaterThan(before)
    expect((await agent.projection()).compaction).toMatchObject({ count: 1, summary: 'summary' })
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('captures an explicit runtime scope and model per turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-runtime-'))
    const events = new SessionEventStore(join(root, 'history'))
    const seen: Array<{ cwd: string; model: string | null; preset: string }> = []
    const agent = new Agent({
      agentId: 'runtime-agent',
      sessionId: 'runtime-session',
      events,
      cwd: root,
      workspaceRoot: root,
      courseId: 'course-1',
      preset: { id: 'studyclaw-learning', systemPrompt: 'base prompt' },
      capabilities: [{ id: 'sandbox', available: false, reason: 'missing', installAction: 'install' }],
      modelSelection: { provider: 'mock', model: 'alpha' },
      runner: async function* (_input, context) {
        seen.push({ cwd: context.cwd, model: context.modelSelection?.model ?? null, preset: context.preset.id })
        yield { type: 'assistant/message', payload: { content: 'ok' } }
      },
    })
    const first = agent.send({ content: 'first' })
    for await (const _event of first.events) { /* drain */ }
    await agent.selectModel({ provider: 'mock', model: 'beta', effort: 'high' })
    const second = agent.send({ content: 'second' })
    for await (const _event of second.events) { /* drain */ }
    expect(seen).toEqual([
      { cwd: root, model: 'alpha', preset: 'studyclaw-learning' },
      { cwd: root, model: 'beta', preset: 'studyclaw-learning' },
    ])
    const projection = await agent.projection()
    expect(projection.agentRuntime).toMatchObject({ cwd: root, systemPrompt: 'base prompt' })
    expect(projection.currentModel).toEqual({ provider: 'mock', model: 'beta', effort: 'high' })
    expect((await events.load('runtime-session')).some(row => row.type === 'agent/runtime')).toBe(true)
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('parks injected context across cancellation and exposes it at the next model boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-injected-'))
    const events = new SessionEventStore(join(root, 'history'))
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const seen: string[][] = []
    const agent = new Agent({
      agentId: 'injected-agent',
      sessionId: 'injected-session',
      events,
      runner: async function* (input, context) {
        seen.push([input.content, ...context.inbox.injected.map(item => item.content)])
        started()
        if (input.content === 'first') {
          await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        yield { type: 'assistant/message', payload: { content: 'resumed' } }
      },
    })
    agent.send({ content: 'first' })
    await startedPromise
    const parked = agent.inject({ content: 'tool result context' })
    agent.cancel({ keepInbox: true })
    await agent.whenIdle()
    agent.send({ content: 'wake' })
    expect(agent.attach('missing')).toBeUndefined()
    await agent.whenIdle()
    expect(seen).toEqual([
      ['first'],
      ['wake', 'tool result context'],
    ])
    expect((await events.load('injected-session')).some(row => row.type === 'agent/context')).toBe(true)
    await expect((async () => { for await (const _event of parked.events) { /* closed when consumed */ } })()).resolves.toBeUndefined()
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('queues sends behind maintenance and replays a completed turn after its live handle is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-maintenance-queue-'))
    const events = new SessionEventStore(join(root, 'history'))
    let releaseMaintenance!: () => void
    const maintenanceReady = new Promise<void>(resolve => { releaseMaintenance = resolve })
    const seen: string[] = []
    const agent = new Agent({
      agentId: 'maintenance-queue-agent',
      sessionId: 'maintenance-queue-session',
      events,
      runner: async function* (input) {
        seen.push(input.content)
        yield { type: 'assistant/message', payload: { content: `ok:${input.content}` } }
      },
    })
    const maintenance = agent.runMaintenance(async signal => {
      await maintenanceReady
      if (signal.aborted) throw new Error('maintenance aborted')
      return 'done'
    })
    const handle = agent.send({ content: 'after-maintenance' })
    expect(agent.status.phase).toBe('queued')
    releaseMaintenance()
    await expect(maintenance).resolves.toBe('done')
    for await (const _event of handle.events) { /* drain */ }
    await agent.whenIdle()
    expect(seen).toEqual(['after-maintenance'])
    const replay = agent.attach(handle.turnId)
    expect(replay).toBeDefined()
    const replayed: string[] = []
    for await (const event of replay!.events) replayed.push(event.type)
    expect(replayed).toContain('assistant/message')
    await agent.dispose()
    await rm(root, { recursive: true, force: true })
  })
})
