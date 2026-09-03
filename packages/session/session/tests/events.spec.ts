import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionEventStore } from '../src/events.ts'

describe('SessionEventStore', () => {
  it('一行坏数据不再锁死会话：load 容错，append 自愈并备份原件（P0-6）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-durability-'))
    const store = new SessionEventStore(root)
    await store.append('s',
      { ts: '2026-08-22T12:00:00.000Z', type: 'turn/start', payload: {} },
      { ts: '2026-08-22T12:00:00.004Z', type: 'turn/end', payload: {} },
    )
    const path = store.pathFor('s')
    // 模拟断电半行写入。
    await writeFile(path, (await readFile(path, 'utf8')) + '{"ts":"2026-08-22T12', 'utf8')
    // load 只返回合法前缀，不抛错。
    const before = await store.load('s')
    expect(before.map(row => row.seq)).toEqual([1, 2])
    // 追加自愈：seq 续排、文件重建为可读格式、原件备份落盘。
    const appended = await store.append('s', { ts: '2026-08-22T12:00:01.000Z', type: 'user/input', payload: { content: '继续' } })
    expect(appended.map(row => row.seq)).toEqual([3])
    const healed = await store.load('s')
    expect(healed).toHaveLength(3)
    const files = await readdir(root)
    expect(files.some(file => file.startsWith('session_s.events.jsonl.corrupt-'))).toBe(true)
    // 再追加回到健康快速路径（纯追加），seq 依然连续。
    await store.append('s', { ts: '2026-08-22T12:00:02.000Z', type: 'turn/end', payload: {} })
    await expect(store.load('s').then(rows => rows.map(row => row.seq))).resolves.toEqual([1, 2, 3, 4])
    await rm(root, { recursive: true, force: true })
  })

  it('拒绝路径注入式 sessionId（SEC-6）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-injection-'))
    const store = new SessionEventStore(root)
    for (const evil of ['../../../sources/x', '..\\escape', '/abs/path', 'a/b', '.hidden', '..']) {
      expect(() => store.pathFor(evil)).toThrow('非法会话 ID')
      await expect(store.append(evil, { ts: '2026-08-22T12:00:00.000Z', type: 'turn/start', payload: {} })).rejects.toThrow('非法会话 ID')
      await expect(store.load(evil)).rejects.toThrow('非法会话 ID')
    }
    // 合法形态不受影响：时间戳 id 与不透明运行时 id。
    await store.append('20260822-120000', { ts: '2026-08-22T12:00:00.000Z', type: 'turn/start', payload: {} })
    await store.append('child-session-1', { ts: '2026-08-22T12:00:00.001Z', type: 'turn/end', payload: {} })
    await rm(root, { recursive: true, force: true })
  })

  it('appends, validates sequence, and projects an agent session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-'))
    const store = new SessionEventStore(root)
    await store.append('s',
      { ts: '2026-08-22T12:00:00.000Z', type: 'session/model', payload: { provider: 'acme', model: 'small' } },
      { ts: '2026-08-22T12:00:00.001Z', type: 'turn/start', payload: {} },
      { ts: '2026-08-22T12:00:00.002Z', type: 'user/input', payload: { content: 'hello' } },
      { ts: '2026-08-22T12:00:00.003Z', type: 'assistant/message', payload: { content: 'world' } },
      { ts: '2026-08-22T12:00:00.004Z', type: 'turn/end', payload: {} },
    )
    const rows = await store.load('s')
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3, 4, 5])
    await expect(store.project('s')).resolves.toMatchObject({
      currentModel: { provider: 'acme', model: 'small' },
      phase: 'idle',
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
    })
    await rm(root, { recursive: true, force: true })
  })

  it('projects tool lifecycle, approval, plan, todo and usage state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-projection-'))
    const store = new SessionEventStore(root)
    await Promise.all([
      store.append('s', { ts: '2026-08-22T12:00:00.000Z', type: 'tool/call', payload: { callId: 'c1', name: 'read_file', args: { path: 'README.md' } } }),
      store.append('s', { ts: '2026-08-22T12:00:00.001Z', type: 'approval/pending', payload: { requestId: 'a1', name: 'write_file', policy: 'write', args: { path: 'x' } } }),
    ])
    await store.append('s',
      { ts: '2026-08-22T12:00:00.002Z', type: 'tool/result', payload: { callId: 'c1', name: 'read_file', status: 'success', summary: '已读取', data: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } } },
      { ts: '2026-08-22T12:00:00.003Z', type: 'approval/resolved', payload: { requestId: 'a1', decision: 'deny' } },
      { ts: '2026-08-22T12:00:00.004Z', type: 'plan/update', payload: { steps: [{ id: 's1', text: '检查文件', status: 'in_progress' }] } },
      { ts: '2026-08-22T12:00:00.005Z', type: 'todo/update', payload: { items: [{ id: 't1', text: '确认结果', status: 'completed' }] } },
      { ts: '2026-08-22T12:00:00.006Z', type: 'agent/child', payload: { childAgentId: 'child-1', childSessionId: 'child-session-1' } },
    )
    const projection = await store.project('s')
    expect(projection.tools[0]).toMatchObject({ callId: 'c1', status: 'success', args: { path: 'README.md' } })
    expect(projection.pendingApprovals).toEqual([])
    expect(projection.plan.steps[0]).toMatchObject({ id: 's1', status: 'in_progress' })
    expect(projection.todos[0]).toMatchObject({ id: 't1', status: 'completed' })
    expect(projection.usage.totalTokens).toBe(5)
    expect(projection.children).toEqual([{ agentId: 'child-1', sessionId: 'child-session-1', seq: 7 }])
    await rm(root, { recursive: true, force: true })
  })

  it('excludes user inputs voided by failed-turn compensation events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-voided-'))
    const store = new SessionEventStore(root)
    await store.append('s',
      { ts: '2026-08-22T12:00:00.000Z', type: 'user/input', payload: { content: '失败的那条' } },
      { ts: '2026-08-22T12:00:00.001Z', type: 'turn/error', payload: { message: 'boom' } },
      { ts: '2026-08-22T12:00:00.002Z', type: 'input/voided', payload: { seq: 1, reason: 'turn-failed' } },
      { ts: '2026-08-22T12:00:00.003Z', type: 'turn/end', payload: { reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } } },
      { ts: '2026-08-22T12:00:00.004Z', type: 'user/input', payload: { content: '重发的同一条' } },
      { ts: '2026-08-22T12:00:00.005Z', type: 'assistant/message', payload: { content: '回答' } },
    )
    const projection = await store.project('s')
    expect(projection.messages.map(message => [message.role, message.content])).toEqual([['user', '重发的同一条'], ['assistant', '回答']])
    // 分支定位与投影同口径：被 void 的输入不计入对话边界。
    await store.forkSession('s', 'fork', 1)
    const forked = await store.project('fork')
    expect(forked.messages.map(message => message.content)).toEqual(['重发的同一条', '回答'])
    await rm(root, { recursive: true, force: true })
  })

  it('forks event history with lineage and a chat boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-fork-'))
    const store = new SessionEventStore(root)
    await store.append('source',
      { ts: '2026-08-22T12:00:00.000Z', type: 'user/input', payload: { content: 'one' } },
      { ts: '2026-08-22T12:00:00.001Z', type: 'assistant/message', payload: { content: 'answer' } },
      { ts: '2026-08-22T12:00:00.002Z', type: 'user/input', payload: { content: 'two' } },
    )
    await store.forkSession('source', 'fork', 1)
    const projection = await store.project('fork')
    expect(projection.messages.map(message => message.content)).toEqual(['one', 'answer'])
    expect(projection.lineage).toMatchObject({ parentSessionId: 'source', forkSeq: 2 })
    await rm(root, { recursive: true, force: true })
  })

  it('projects durable maintenance jobs across queued, running and terminal events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-maintenance-'))
    const store = new SessionEventStore(root)
    await store.append('s',
      { ts: '2026-08-22T12:00:00.000Z', type: 'maintenance/queued', payload: { jobId: 'm1', agentId: 'a1', kind: 'compaction', summary: 'trim' } },
      { ts: '2026-08-22T12:00:00.001Z', type: 'maintenance/start', payload: { jobId: 'm1', agentId: 'a1', kind: 'compaction' } },
      { ts: '2026-08-22T12:00:00.002Z', type: 'maintenance/end', payload: { jobId: 'm1', agentId: 'a1', kind: 'compaction', lastSeq: 3 } },
      { ts: '2026-08-22T12:00:00.003Z', type: 'maintenance/queued', payload: { jobId: 'm2', agentId: 'a1', kind: 'checkpoint' } },
      { ts: '2026-08-22T12:00:00.004Z', type: 'maintenance/error', payload: { jobId: 'm2', agentId: 'a1', kind: 'checkpoint', message: 'busy' } },
    )
    const projection = await store.project('s')
    expect(projection.maintenanceJobs).toEqual([
      expect.objectContaining({ jobId: 'm1', status: 'done', summary: 'trim', startedAt: '2026-08-22T12:00:00.001Z' }),
      expect.objectContaining({ jobId: 'm2', status: 'failed', error: 'busy' }),
    ])
    await rm(root, { recursive: true, force: true })
  })

  it('projects an immutable Agent runtime configuration snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-agent-config-'))
    const store = new SessionEventStore(root)
    await store.append('s', {
      ts: '2026-08-22T12:00:00.000Z',
      type: 'agent/config',
      payload: { agentPreset: 'general', permissionPreset: 'read-only', plugins: { learning: false, sandbox: true } },
    })
    await store.append('s', {
      ts: '2026-08-22T12:00:00.001Z',
      type: 'agent/config',
      payload: { agentPreset: 'studyclaw-learning', permissionPreset: 'danger-full-access', plugins: { learning: true } },
    })
    await expect(store.project('s')).resolves.toMatchObject({
      agentConfig: { agentPreset: 'general', permissionPreset: 'read-only', plugins: { learning: false, sandbox: true } },
    })
    await rm(root, { recursive: true, force: true })
  })

  it('validates typed first-party event payloads while keeping plugin events open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-typed-'))
    const store = new SessionEventStore(root)
    await expect(store.appendKnown('s', 'turn/cancelled', { reason: '' })).rejects.toThrow()
    expect(await store.load('s')).toEqual([])
    await expect(store.appendKnown('s', 'turn/end', { reason: { kind: 'blocked', blockers: ['ask-user'] } })).resolves.toMatchObject({ type: 'turn/end' })
    await expect(store.appendUnknown('s', 'plugin/custom', { value: true })).resolves.toMatchObject({ type: 'plugin/custom' })
    await rm(root, { recursive: true, force: true })
  })

  it('projects blocked terminal turns as waiting instead of idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-blocked-'))
    const store = new SessionEventStore(root)
    await store.appendKnown('s', 'ask/pending', { question: '继续吗？' })
    await store.appendKnown('s', 'turn/end', { reason: { kind: 'blocked', blockers: ['ask-user'] } })
    await expect(store.project('s')).resolves.toMatchObject({ phase: 'waiting', pendingAsk: '继续吗？' })
    await rm(root, { recursive: true, force: true })
  })

  it('replays interrupted messages and structured terminal reasons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-interrupted-'))
    const store = new SessionEventStore(root)
    await store.appendKnown('s', 'assistant/message', { content: 'partial', interrupted: true })
    await store.appendKnown('s', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    await expect(store.project('s')).resolves.toMatchObject({
      messages: [{ role: 'assistant', content: 'partial', interrupted: true }],
      lastTurnEndReason: { kind: 'aborted', reason: { kind: 'disposed' } },
      phase: 'cancelled',
    })
    await rm(root, { recursive: true, force: true })
  })

  it('A5: assistant/voided 与 input/voided 对称剔除失败重试的孤儿回复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-events-assistant-voided-'))
    const store = new SessionEventStore(root)
    // 模拟 service.ts 失败重试补写后的日志形态：旧 turn 部分输出 + 终态失败
    // → input/voided + assistant/voided → 新 turn 完整落盘。
    await store.append('s',
      { ts: '2026-09-03T10:00:00.000Z', type: 'user/input', payload: { content: '解释一下', requestId: 'req_x', turnId: 't1' } },
      { ts: '2026-09-03T10:00:00.001Z', type: 'assistant/message', payload: { content: '半截回复' }, turnId: 't1' },
      { ts: '2026-09-03T10:00:00.002Z', type: 'turn/error', payload: { message: '工具失败' }, turnId: 't1' },
      { ts: '2026-09-03T10:00:00.003Z', type: 'input/voided', payload: { seq: 1, reason: 'turn-failed-retry' } },
      { ts: '2026-09-03T10:00:00.004Z', type: 'assistant/voided', payload: { seq: 2, reason: 'turn-failed-retry' } },
      { ts: '2026-09-03T10:00:00.005Z', type: 'user/input', payload: { content: '解释一下', requestId: 'req_x', turnId: 't2' } },
      { ts: '2026-09-03T10:00:00.006Z', type: 'assistant/message', payload: { content: '完整回复' }, turnId: 't2' },
    )
    const projection = await store.project('s')
    // 旧 turn 的半截回复与用户输入一并剔除：无重复 user、无孤儿 assistant。
    expect(projection.messages.map(message => [message.role, message.content])).toEqual([
      ['user', '解释一下'],
      ['assistant', '完整回复'],
    ])
    await rm(root, { recursive: true, force: true })
  })
})
