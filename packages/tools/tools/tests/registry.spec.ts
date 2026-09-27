/**
 * ToolRegistry suite: argument validation (required/unknown/coercion),
 * mode-based policy filtering with fail-closed fallback, and the file
 * handlers (read_source range, search grep, get_course_state).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentToolRegistry, buildDefaultSpecs, buildGenericSpecs, defaultToolRegistry, ToolRejected, ToolRegistry, ToolRuntime, type ToolActions } from '../src/index.ts'

async function setup(): Promise<{ root: string; courseDir: string; wsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-tools-'))
  const wsRoot = join(root, 'ws')
  // 项目即课程：状态/资料就地位于项目根。
  const courseDir = wsRoot
  await mkdir(join(courseDir, 'docs'), { recursive: true })
  await mkdir(join(wsRoot, '.studyclaw'), { recursive: true })
  await writeFile(join(courseDir, 'docs', 'a.md'), '# 标题\n第一行内容。\n第二行。\n第三行。\n', 'utf8')
  await writeFile(join(courseDir, '.hidden.md'), '隐藏\n', 'utf8')
  await writeFile(join(courseDir, 'docs', 'b.txt'), '关键字在这里\n另一行\n', 'utf8')
  await writeFile(join(wsRoot, '.studyclaw', 'Memory.md'), '全局画像：OOP 薄弱。\n', 'utf8')
  await writeFile(join(courseDir, 'syllabus.json'), JSON.stringify({
    course_id: 'c1', title: 'OOP', version: '1.0.0',
    chapters: [{ id: 'chap_1', title: '封装', concepts: [{ id: 'c_1', name: '封装的意义' }] }],
  }), 'utf8')
  await writeFile(join(courseDir, 'progress.md'), [
    '# 学习进度', '', '- **总体掌握度**：40%', '- **待复习卡片数**：1', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
    '|---|---|---|---|---|---|---|---|---|',
    '| c_1 | 封装的意义 | 封装 | 40% | 2 | 50% | 2.5 | 2026-08-22 | none |', '',
  ].join('\n'), 'utf8')
  return { root, courseDir, wsRoot }
}

describe('ToolRegistry', () => {
  it('publishes DSH execution, render and provider metadata for every spec', () => {
    const specs = [...buildDefaultSpecs(), ...buildGenericSpecs()]
    expect(specs.every(spec => spec.execution === 'parallel' || spec.execution === 'exclusive')).toBe(true)
    expect(specs.every(spec => spec.renderIntent.length > 0)).toBe(true)
    expect(specs.find(spec => spec.name === 'run_command')).toMatchObject({ execution: 'exclusive', provider: 'subprocess', renderIntent: 'shell' })
    expect(specs.find(spec => spec.name === 'read_source')).toMatchObject({ execution: 'parallel', renderIntent: 'file' })
    expect(specs.find(spec => spec.name === 'plan')).toMatchObject({ requiresApproval: false })
    expect(specs.find(spec => spec.name === 'write_file')).toMatchObject({ requiresApproval: true })
  })

  it('validates required/unknown args and rejects bad paths', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const ctx = { courseDir, workspaceRoot: wsRoot }

    const missing = await registry.execute('read_source', {}, ctx)
    expect(missing.status).toBe('rejected')
    expect(missing.summary).toContain('缺少必填参数')

    const unknown = await registry.execute('read_source', { path: 'a.md', conceptId: 'c_1' }, ctx)
    expect(unknown.status).toBe('rejected')
    expect(unknown.summary).toContain('未知参数')

    const traversal = await registry.execute('read_source', { path: '../../etc/passwd' }, ctx)
    expect(traversal.status).toBe('rejected')

    const hidden = await registry.execute('read_source', { path: '.hidden.md' }, ctx)
    expect(hidden.status).toBe('rejected')
    await rm(root, { recursive: true, force: true })
  })

  it('read_source returns a line range and truncation flag', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const ctx = { courseDir, workspaceRoot: wsRoot }
    const result = await registry.execute('read_source', { path: 'docs/a.md', startLine: 2, endLine: 3 }, ctx)
    expect(result.status).toBe('success')
    expect(result.data['lines']).toEqual([{ n: 2, text: '第一行内容。' }, { n: 3, text: '第二行。' }])
    expect(result.toEvent('read_source', { path: 'docs/a.md' }, 'call-1')).toMatchObject({ callId: 'call-1', renderIntent: 'file' })
    await rm(root, { recursive: true, force: true })
  })

  it('search_sources greps case-insensitively and counts files', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const ctx = { courseDir, workspaceRoot: wsRoot }
    const result = await registry.execute('search_sources', { query: '关键字' }, ctx)
    expect(result.status).toBe('success')
    expect(result.data['matches']).toHaveLength(1)
    expect((result.data['matches'] as Array<{ file: string }>)[0]!['file']).toBe('docs/b.txt')
    await rm(root, { recursive: true, force: true })
  })

  it('get_course_state projects syllabus + mastery + due', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const ctx = { courseDir, workspaceRoot: wsRoot }
    const result = await registry.execute('get_course_state', {}, ctx)
    expect(result.status).toBe('success')
    expect(result.data['title']).toBe('OOP')
    expect(result.data['mastery']).toEqual({ c_1: 0.4 })
    expect(result.data['dueCount']).toBeGreaterThanOrEqual(0)
    await rm(root, { recursive: true, force: true })
  })

  it('mode filtering: socratic exposes readonly + ask; unknown mode falls back', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const socratic = registry.namesForMode('socratic')
    expect(socratic).toContain('read_source')
    expect(socratic).toContain('ask_user_question')
    expect(socratic).not.toContain('run_quiz')

    const unknown = registry.namesForMode('bogus')
    expect(unknown.sort()).toEqual(['get_course_state', 'read_source', 'search_sources'])

    const schemas = registry.schemasForMode('feynman')
    const names = schemas.map(s => (s['function'] as { name: string }).name)
    expect(names).toContain('write_note')
    expect(names).not.toContain('run_quiz')
    await rm(root, { recursive: true, force: true })
  })

  it('general preset exposes the generic DSH tool inventory', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const names = registry.namesForMode('general')
    expect(names).toEqual(expect.arrayContaining([
      'read_file', 'search_files', 'write_file', 'run_command', 'fetch_url',
      'search_web', 'spawn_agent', 'lsp', 'ask_user_question', 'plan', 'todo',
    ]))
    expect(names).not.toContain('run_quiz')
    const planSchema = registry.schemasForMode('general').find(item => (item['function'] as { name: string }).name === 'plan')
    expect((planSchema?.['function'] as { parameters: Record<string, unknown> }).parameters).toMatchObject({
      properties: { steps: { items: { anyOf: expect.any(Array) } } },
    })
    await rm(root, { recursive: true, force: true })
  })

  it('write_note appends and keeps content out of the audit args', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const ctx = { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' as const }
    const result = await registry.execute('write_note', { content: '我的理解：封装是隐藏实现。', conceptId: 'c_1' }, ctx)
    expect(result.status).toBe('success')
    const notes = await (await import('node:fs/promises')).readFile(join(courseDir, 'notes.md'), 'utf8')
    expect(notes).toContain('[c_1] 我的理解：封装是隐藏实现。')
    expect(registry.actionAudit).toHaveLength(1)
    expect(registry.actionAudit[0]!.name).toBe('write_note')
    await rm(root, { recursive: true, force: true })
  })

  it('preserves long execution strings while keeping public audit data bounded', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const content = '长笔记'.repeat(100)
    const result = await registry.execute('write_note', { content }, { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' as const })
    expect(result.status).toBe('success')
    const notes = await (await import('node:fs/promises')).readFile(join(courseDir, 'notes.md'), 'utf8')
    expect(notes).toContain(content)
    expect(registry.actionAudit[0]?.summary).toBeTruthy()
    await rm(root, { recursive: true, force: true })
  })

  it('projects only plan and todo state into durable tool events', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const plan = await registry.execute('plan', { steps: ['读取资料', '总结'] }, { courseDir, workspaceRoot: wsRoot })
    const todo = await registry.execute('todo', { items: [{ id: 't1', text: '验证', status: 'pending' }] }, { courseDir, workspaceRoot: wsRoot })
    const planEvent = plan.toEvent('plan', {})
    const todoEvent = todo.toEvent('todo', {})
    expect(planEvent.data).toEqual({ steps: ['读取资料', '总结'] })
    expect(todoEvent.data).toEqual({ items: [{ id: 't1', text: '验证', status: 'pending' }] })
    const learning = await registry.execute('get_memory', {}, { courseDir, workspaceRoot: wsRoot })
    expect(learning.toEvent('get_memory', {})).not.toHaveProperty('data')
    await rm(root, { recursive: true, force: true })
  })

  it('keeps internal planning and quiz tools out of the approval queue', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const approvals: string[] = []
    const ctx = { courseDir, workspaceRoot: wsRoot, approval: async (request: { name: string }) => { approvals.push(request.name); return 'allow' as const } }
    expect((await registry.execute('plan', { steps: ['一步'] }, ctx)).status).toBe('success')
    expect((await registry.execute('run_review', {}, ctx)).status).toBe('degraded')
    expect(approvals).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('fails closed for course mutations when the Host omits approval', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const result = await registry.execute('write_note', { content: 'must not bypass approval' }, { courseDir, workspaceRoot: wsRoot })
    expect(result).toMatchObject({ status: 'degraded', error: 'APPROVAL_UNAVAILABLE' })
    await expect(readFile(join(courseDir, 'notes.md'), 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('validates structured plan steps while projecting only safe fields', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const structured = await registry.execute('plan', {
      steps: [{ id: 'inspect', title: '检查实现', status: 'in_progress', secret: 'drop me' }],
    }, { courseDir, workspaceRoot: wsRoot })
    expect(structured.status).toBe('success')
    expect(structured.data['steps']).toEqual([{ id: 'inspect', text: '检查实现', status: 'in_progress' }])
    const invalid = await registry.execute('plan', { steps: [{ status: 'blocked' }] }, { courseDir, workspaceRoot: wsRoot })
    expect(invalid.status).toBe('rejected')
    await rm(root, { recursive: true, force: true })
  })

  it('uses the registered tool retry backoff when no override is provided', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = new ToolRegistry(courseDir, wsRoot)
    registry.register({
      name: 'flaky', parameters: { type: 'object', properties: {} }, description: 'flaky', policy: 'read',
      timeout: 1, execution: 'parallel', renderIntent: 'warning', retry: { maxRetries: 1, backoffMs: 25 },
    }, async () => { throw new Error('temporary') })
    const started = Date.now()
    const result = await registry.executeWithRetry('flaky', {}, { courseDir, workspaceRoot: wsRoot })
    expect(result.status).toBe('degraded')
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
    await rm(root, { recursive: true, force: true })
  })

  it('runs DSH middleware around a normalized tool dispatch', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const phases: string[] = []
    const registry = new ToolRuntime(courseDir, wsRoot, [{
      preExecute: () => { phases.push('pre') },
      aroundExecute: async (_execution, next) => { phases.push('around:start'); const result = await next(); phases.push('around:end'); return result },
      postExecute: (_execution, result) => { phases.push(`post:${result.status}`) },
    }])
    registry.register(buildDefaultSpecs().find(spec => spec.name === 'read_source')!, async ctx => [`${ctx.courseDir}`, {}])
    const result = await registry.execute('read_source', { path: 'docs/a.md' }, { courseDir, workspaceRoot: wsRoot })
    expect(result.status).toBe('success')
    expect(phases).toEqual(['pre', 'around:start', 'around:end', 'post:success'])
    await rm(root, { recursive: true, force: true })
  })

  it('contains post-execute projection failures without rerunning middleware', async () => {
    const { root, courseDir, wsRoot } = await setup()
    let postCalls = 0
    const registry = new ToolRuntime(courseDir, wsRoot, [{
      postExecute: () => {
        postCalls += 1
        throw new Error('projection unavailable')
      },
    }])
    registry.register(buildDefaultSpecs().find(spec => spec.name === 'read_source')!, async () => ['ok', {}])
    const result = await registry.execute('read_source', { path: 'docs/a.md' }, { courseDir, workspaceRoot: wsRoot })
    expect(result).toMatchObject({ status: 'degraded', error: 'TOOL_RUNTIME_POST_EXECUTE' })
    expect(postCalls).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  it('normalizes malformed handler output and timeout into stable error codes', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = new ToolRegistry(courseDir, wsRoot)
    registry.register({
      name: 'malformed', parameters: { type: 'object', properties: {} }, description: 'malformed', policy: 'read',
      timeout: 1, execution: 'parallel', renderIntent: 'warning', retry: { maxRetries: 0, backoffMs: 0 },
    }, async () => undefined as never)
    const malformed = await registry.execute('malformed', {}, { courseDir, workspaceRoot: wsRoot })
    expect(malformed).toMatchObject({ status: 'degraded', error: 'TOOL_INVALID_OUTPUT', renderIntent: 'warning' })
    registry.register({
      name: 'slow', parameters: { type: 'object', properties: {} }, description: 'slow', policy: 'read',
      timeout: 0.01, execution: 'parallel', renderIntent: 'warning', retry: { maxRetries: 0, backoffMs: 0 },
    }, async ctx => await new Promise(resolve => ctx.signal?.addEventListener('abort', () => resolve(['stopped', {}] as [string, Record<string, unknown>]), { once: true })))
    const timeout = await registry.execute('slow', {}, { courseDir, workspaceRoot: wsRoot })
    expect(timeout).toMatchObject({ status: 'degraded', error: 'TOOL_TIMEOUT', renderIntent: 'warning' })
    await rm(root, { recursive: true, force: true })
  })

  it('keeps parallel reads bounded and places exclusive calls behind a barrier', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = new ToolRegistry(courseDir, wsRoot)
    const active: string[] = []
    const maxActive: number[] = []
    const register = (name: string, execution: 'parallel' | 'exclusive', delay: number) => {
      registry.register({
        name,
        parameters: { type: 'object', properties: {} },
        description: name,
        policy: execution === 'parallel' ? 'read' : 'action',
        timeout: 2,
        execution,
        renderIntent: 'warning',
        retry: { maxRetries: 0, backoffMs: 0 },
      }, async () => {
        active.push(name)
        maxActive.push(active.length)
        await new Promise(resolve => setTimeout(resolve, delay))
        active.splice(active.indexOf(name), 1)
        return [name, {}]
      })
    }
    register('read_a', 'parallel', 25)
    register('read_b', 'parallel', 5)
    register('write', 'exclusive', 1)
    const results = await registry.executeBatch([
      { callId: 'a', name: 'read_a', args: {} },
      { callId: 'b', name: 'read_b', args: {} },
      { callId: 'w', name: 'write', args: {} },
    ], { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' })
    expect(results.map(item => item.result.summary)).toEqual(['read_a', 'read_b', 'write'])
    expect(Math.max(...maxActive)).toBe(2)
    expect(active).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('replenishes the parallel pool as fast calls settle', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = new ToolRegistry(courseDir, wsRoot)
    const started: string[] = []
    let releaseSlow!: () => void
    registry.register({
      name: 'gated_read', parameters: { type: 'object', properties: { id: { type: 'string' } } },
      description: 'gated', policy: 'read', timeout: 2, execution: 'parallel', renderIntent: 'search', retry: { maxRetries: 0, backoffMs: 0 },
    }, async (_ctx, args) => {
      const id = String(args['id'])
      started.push(id)
      if (id === 'slow') await new Promise<void>(resolve => { releaseSlow = resolve })
      return [`done-${id}`, {}]
    })
    const batch = registry.executeBatch([
      { callId: '1', name: 'gated_read', args: { id: 'slow' } },
      { callId: '2', name: 'gated_read', args: { id: 'fast' } },
      { callId: '3', name: 'gated_read', args: { id: 'refill' } },
    ], { courseDir, workspaceRoot: wsRoot }, { maxParallel: 2 })
    for (let i = 0; i < 20 && !started.includes('refill'); i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(started).toEqual(['slow', 'fast', 'refill'])
    releaseSlow()
    const results = await batch
    expect(results.map(item => item.result.summary)).toEqual(['done-slow', 'done-fast', 'done-refill'])
    await rm(root, { recursive: true, force: true })
  })

  it('records synthetic results for calls skipped after cancellation', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = new ToolRegistry(courseDir, wsRoot)
    const controller = new AbortController()
    const started: string[] = []
    let release!: () => void
    registry.register({
      name: 'cancel_read', parameters: { type: 'object', properties: { id: { type: 'string' } } },
      description: 'cancel', policy: 'read', timeout: 2, execution: 'parallel', renderIntent: 'search', retry: { maxRetries: 0, backoffMs: 0 },
    }, async (ctx, args) => {
      const id = String(args['id'])
      started.push(id)
      if (id === 'one') await new Promise<void>(resolve => {
        release = resolve
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return [`done-${id}`, {}]
    })
    const batch = registry.executeBatch([
      { callId: '1', name: 'cancel_read', args: { id: 'one' } },
      { callId: '2', name: 'cancel_read', args: { id: 'two' } },
      { callId: '3', name: 'cancel_read', args: { id: 'three' } },
    ], { courseDir, workspaceRoot: wsRoot, signal: controller.signal }, { maxParallel: 1 })
    for (let i = 0; i < 20 && started.length < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort('test')
    release()
    const results = await batch
    expect(started).toEqual(['one'])
    expect(results.map(item => item.result.error)).toEqual(['TOOL_CANCELLED', 'TOOL_ABORTED_BEFORE_DISPATCH', 'TOOL_ABORTED_BEFORE_DISPATCH'])
    expect(results.map(item => item.call.callId)).toEqual(['1', '2', '3'])
    await rm(root, { recursive: true, force: true })
  })

  it('routes every learning action through injected ToolActions', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const calls: string[] = []
    const actions: ToolActions = {
      getTaskPool: async () => { calls.push('get_task_pool'); return ['题卡池 0 张', { count: 0 }] },
      createCard: async () => { calls.push('create_card'); return ['已生成', { tasks: [] }] },
      generateDynamicCard: async () => { calls.push('generate_dynamic_card'); return ['已生成', { tasks: [] }] },
      runReview: async () => { calls.push('run_review'); return ['已准备', { tasks: [] }] },
      runQuiz: async () => { calls.push('run_quiz'); return ['已准备', { tasks: [] }] },
      evaluateAnswer: async () => { calls.push('evaluate_answer'); return ['通过', { passed: true }] },
      syncSources: async () => { calls.push('sync_sources'); return ['已同步', {}] },
    }
    const ctx = { courseDir, workspaceRoot: wsRoot, actions, approval: async () => 'allow' as const }
    const inputs: Array<[string, Record<string, unknown>]> = [
      ['get_task_pool', {}],
      ['create_card', { content: '一段内容' }],
      ['generate_dynamic_card', { taskId: 'task_1', misconception: '误区' }],
      ['run_review', {}],
      ['run_quiz', {}],
      ['evaluate_answer', { taskId: 'task_1', answer: '作答' }],
      ['sync_sources', {}],
    ]
    for (const [name, args] of inputs) {
      const result = await registry.execute(name, args, ctx)
      expect(result.status, name).toBe('success')
    }
    expect(calls).toEqual(inputs.map(([name]) => name))
    await rm(root, { recursive: true, force: true })
  })

  it('degrades action tools clearly when host actions are not injected', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = defaultToolRegistry(courseDir, wsRoot)
    const result = await registry.execute('run_quiz', {}, { courseDir, workspaceRoot: wsRoot })
    expect(result.status).toBe('degraded')
    expect(result.summary).toContain('工具动作未注入')
    await rm(root, { recursive: true, force: true })
  })

  it('generic filesystem tools enforce workspace containment and approval', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const denied = await registry.execute('write_file', { path: 'notes.txt', content: 'blocked' }, { courseDir, workspaceRoot: wsRoot, approval: async () => 'deny' })
    expect(denied.status).toBe('rejected')
    const allowed = await registry.execute('write_file', { path: 'notes.txt', content: 'hello' }, { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' })
    expect(allowed.status).toBe('success')
    const read = await registry.execute('read_file', { path: 'notes.txt' }, { courseDir, workspaceRoot: wsRoot })
    expect(read.data['content']).toBe('hello')
    const escaped = await registry.execute('read_file', { path: '../outside.txt' }, { courseDir, workspaceRoot: wsRoot })
    expect(escaped.status).toBe('rejected')
    await rm(root, { recursive: true, force: true })
  })

  it('fails closed when an approval-gated tool has no approval channel', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const result = await registry.execute('write_file', { path: 'notes.txt', content: 'must not write' }, { courseDir, workspaceRoot: wsRoot })
    expect(result).toMatchObject({ status: 'degraded', error: 'APPROVAL_UNAVAILABLE' })
    await expect(readFile(join(wsRoot, 'notes.txt'), 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps deployment tools degraded when providers are unavailable', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    for (const [name, args] of [
      ['run_command', { command: 'echo ok' }],
      ['fetch_url', { url: 'https://example.com' }],
      ['search_web', { query: 'study' }],
      ['spawn_agent', { task: 'inspect' }],
      ['lsp', { operation: 'hover', file_path: 'src/index.ts', line: 1, character: 1 }],
    ] as const) {
      const result = await registry.execute(name, args, { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' })
      expect(result.status, name).toBe('degraded')
    }
    await rm(root, { recursive: true, force: true })
  })

  it('converts one-based LSP coordinates and projects bounded results', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    let received: Record<string, unknown> | null = null
    const result = await registry.execute('lsp', { operation: 'goToDefinition', file_path: 'src/index.ts', line: 3, character: 5 }, {
      courseDir,
      workspaceRoot: wsRoot,
      providers: {
        lsp: async input => {
          received = input.params
          return { kind: 'locations', locations: [{ uri: 'file:///workspace/src/index.ts', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } }], resolvedWorkspaceUri: 'file:///workspace' }
        },
      },
    })
    expect(result.status).toBe('success')
    expect(received).toEqual({ filePath: 'src/index.ts', position: { line: 2, character: 4 } })
    expect(result.data).toMatchObject({ kind: 'locations', locations: [{ uri: 'file:///workspace/src/index.ts' }] })
    await rm(root, { recursive: true, force: true })
  })

  it('executes spawn_agent through an injected provider and forwards cancellation', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    let received: { task: string; cwd: string; signal?: AbortSignal } | null = null
    const result = await registry.execute('spawn_agent', { task: '检查实现' }, {
      courseDir,
      workspaceRoot: wsRoot,
      approval: async () => 'allow',
      providers: {
        subagent: async input => { received = input; return { agentId: 'child-1', status: 'queued', summary: '子 Agent 已排队' } },
      },
    })
    expect(result.status).toBe('success')
    expect(result.data).toMatchObject({ agentId: 'child-1', status: 'queued' })
    expect(received).toMatchObject({ task: '检查实现', cwd: wsRoot })
    await rm(root, { recursive: true, force: true })
  })

  it('prefers an isolated sandbox provider for run_command', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const calls: string[] = []
    const result = await registry.execute('run_command', { command: 'echo isolated' }, {
      courseDir,
      workspaceRoot: wsRoot,
      approval: async () => 'allow',
      providers: {
        sandbox: async input => { calls.push(`sandbox:${input.command}`); return { stdout: 'isolated', stderr: '', exitCode: 0 } },
        subprocess: async input => { calls.push(`local:${input.command}`); return { stdout: 'local', stderr: '', exitCode: 0 } },
      },
    })
    expect(result.status).toBe('success')
    expect(result.data['stdout']).toBe('isolated')
    expect(calls).toEqual(['sandbox:echo isolated'])
    await rm(root, { recursive: true, force: true })
  })

  it('propagates cancellation to deployment providers and returns structured rejection', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const resultPromise = registry.execute('run_command', { command: 'long' }, {
      courseDir,
      workspaceRoot: wsRoot,
      signal: controller.signal,
      approval: async () => 'allow',
      providers: {
        subprocess: async input => {
          observed = input.signal
          await new Promise(resolve => setTimeout(resolve, 100))
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      },
    })
    controller.abort()
    const result = await resultPromise
    expect(observed).toBeDefined()
    expect(observed).not.toBe(controller.signal)
    expect(observed?.aborted).toBe(true)
    expect(result.status).toBe('rejected')
    expect(result.error).toBe('TOOL_CANCELLED')
    await rm(root, { recursive: true, force: true })
  })

  it('aborts the child handler signal when a tool times out', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const resultPromise = registry.execute('run_command', { command: 'long' }, {
      courseDir,
      workspaceRoot: wsRoot,
      signal: controller.signal,
      approval: async () => 'allow',
      providers: {
        subprocess: async input => {
          observed = input.signal
          await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => resolve(), { once: true }))
          return { stdout: '', stderr: '', exitCode: 1 }
        },
      },
    }, 0.01)
    const result = await resultPromise
    expect(observed).toBeDefined()
    expect(observed).not.toBe(controller.signal)
    expect(observed?.aborted).toBe(true)
    expect(result.status).toBe('degraded')
    expect(result.summary).toContain('tool timeout')
    await rm(root, { recursive: true, force: true })
  })

  it('T-14：审批期间 abort 转结构化 TOOL_CANCELLED（不向调用方抛裸 Error）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const controller = new AbortController()
    const resultPromise = registry.execute('write_note', { content: 'x' }, {
      courseDir,
      workspaceRoot: wsRoot,
      signal: controller.signal,
      approval: async () => {
        // 审批挂起，直到 abort（模拟用户在审批期取消）。
        await new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('tool cancelled')), { once: true }))
        return 'deny' as const
      },
    })
    controller.abort()
    // 旧实现：raceWithAbort 的裸 Error 穿出 execute()，这里是 rejects.toThrow。
    const result = await resultPromise
    expect(result.status).toBe('rejected')
    expect(result.error).toBe('TOOL_CANCELLED')
    await rm(root, { recursive: true, force: true })
  })

  it('T-8：超长工具参数被 schema 上限拦截（prompt 成本放大防护）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const registry = agentToolRegistry(courseDir, wsRoot)
    const result = await registry.execute('evaluate_answer', {
      taskId: 't_1',
      answer: 'x'.repeat(4001),
    }, { courseDir, workspaceRoot: wsRoot, approval: async () => 'allow' })
    expect(result.status).toBe('rejected')
    expect(result.summary).toContain('参数非法')
    await rm(root, { recursive: true, force: true })
  })
})
