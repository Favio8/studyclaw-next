/**
 * UI-1 回归：chatStream 按 requestId 幂等。
 *
 * 同一 requestId 连续两次调用：
 * - 第一次正常执行 agent.send，落盘 user/input（含 requestId），驱动 LLM；
 * - 第二次命中已落盘的 user/input → attach 重放/跟随，不再 agent.send，
 *   不产生重复 user/input、不重复计费、不再请求 LLM。
 *
 * 验证手段：mock OpenAI 服务器计数请求，第二次 chatStream 后计数不增加；
 * 会话 turns 仍为 1；第二次返回的 meta 帧带 replayedTurnId。
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chatStream, listSessions } from '../src/service.ts'
import type { ResolvedChatConfig } from '../src/config.ts'
import { AgentRegistry } from '@studyclaw/agent'
import { SessionEventStore } from '@studyclaw/session'



/** 单轮纯文本回复（无工具调用），保持测试简单稳定。 */
function sseText(res: import('node:http').ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: chunk, finish_reason: null }] })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

let server: Server | null = null
let baseUrl = ''
/** LLM 请求计数：幂等测试的核心断言依据。 */
let llmCallCount = 0

beforeAll(async () => {
  llmCallCount = 0
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      llmCallCount += 1
      sseText(res, [{ content: '重载是同名不同参数，覆写是子类重定义父类方法。' }])
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => {
    const address = server!.address()
    if (typeof address === 'object' && address !== null) {
      baseUrl = `http://127.0.0.1:${address.port}/v1`
    }
    resolve()
  }))
})

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
})

const mockConfig: ResolvedChatConfig = {
  providerId: 'mock',
  model: 'mock-model',
  baseUrl: '',
  apiKeyEnv: 'MOCK_KEY',
  apiKey: 'test-key',
  temperature: 0.3,
  maxConcurrency: 1,
  defaultMode: 'socratic',
}

describe('chatStream requestId 幂等（UI-1）', () => {
  it('同一 requestId 第二次调用重放已落盘 turn，不重复 agent.send / 不重复计费', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-idempotent-'))
    const ws = join(root, 'ws')
    const courseDir = ws
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    await writeFile(join(courseDir, 'overview.md'), '# 多态\n\n重载与覆写。\n', 'utf8')
    await writeFile(join(courseDir, 'syllabus.json'), JSON.stringify({
      course_id: basename(ws), title: '多态', version: '1.0.0',
      chapters: [{ id: 'chap_1', title: '继承', concepts: [{ id: 'c_1', name: '重载与覆写' }] }],
    }), 'utf8')
    await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: mock',
      '  model: mock-model',
      '  api_key_env: MOCK_KEY',
      `  api_base: ${baseUrl}`,
      '  temperature: 0.3',
      '  max_concurrency: 1',
      'ui:',
      '  default_mode: socratic',
      '',
    ].join('\n'), 'utf8')

    process.env.MOCK_KEY = 'test-key'
    const config = await (await import('../src/config.ts')).loadChatConfig(ws)
    delete process.env.MOCK_KEY

    const requestId = 'req_idempotent_test_001'
    const courseId = basename(ws)

    // ── 第一次调用：正常流 ──
    const firstTokens: string[] = []
    let firstSessionId = ''
    for await (const event of chatStream(ws, courseId, { message: '解释覆写', mode: 'socratic', requestId }, config)) {
      if (event.kind === 'meta') firstSessionId = String(event.payload['sessionId'])
      if (event.kind === 'token') firstTokens.push(event.delta)
    }
    expect(firstSessionId).not.toBe('')
    expect(firstTokens.join('')).toContain('覆写')
    const llmCallsAfterFirst = llmCallCount
    expect(llmCallsAfterFirst).toBeGreaterThanOrEqual(1)


    // ── 第二次调用（同 requestId）：应重放，不再请求 LLM ──
    const secondTokens: string[] = []
    let secondSessionId = ''
    let replayedTurnId: string | undefined
    const secondEventKinds: string[] = []
    for await (const event of chatStream(ws, courseId, { message: '解释覆写', mode: 'socratic', requestId, sessionId: firstSessionId }, config)) {
      secondEventKinds.push(event.kind)
      if (event.kind === 'meta') {
        secondSessionId = String(event.payload['sessionId'])
        // 第一个 meta 是重放入口帧（带 replayedTurnId），后续 meta 是重放出的 session/meta 事件
        if (replayedTurnId === undefined) replayedTurnId = event.payload['replayedTurnId'] as string | undefined
      }
      if (event.kind === 'token') secondTokens.push(event.delta)
    }

    // 第二次未再请求 LLM（核心幂等断言）
    expect(llmCallCount).toBe(llmCallsAfterFirst)
    // 同一会话
    expect(secondSessionId).toBe(firstSessionId)
    // meta 帧带 replayedTurnId（证明走了 attach 重放路径）
    expect(replayedTurnId).toBeDefined()
    expect(typeof replayedTurnId).toBe('string')
    // 重放内容与首次一致
    expect(secondTokens.join('')).toBe(firstTokens.join(''))

    // 会话仍只有 1 个 turn（无重复落盘）
    const sessions = await listSessions(ws, courseId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.turns).toBe(1)

    await rm(root, { recursive: true, force: true })
  })

  it('不同 requestId 视为新请求，正常 agent.send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-idempotent2-'))
    const ws = join(root, 'ws')
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    await writeFile(join(ws, 'overview.md'), '# 测试\n\n内容。\n', 'utf8')
    await writeFile(join(ws, 'syllabus.json'), JSON.stringify({
      course_id: basename(ws), title: '测试', version: '1.0.0',
      chapters: [{ id: 'chap_1', title: '章', concepts: [{ id: 'c_1', name: '概念' }] }],
    }), 'utf8')
    await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: mock',
      '  model: mock-model',
      '  api_key_env: MOCK_KEY',
      `  api_base: ${baseUrl}`,
      '  temperature: 0.3',
      '  max_concurrency: 1',
      'ui:',
      '  default_mode: socratic',
      '',
    ].join('\n'), 'utf8')

    process.env.MOCK_KEY = 'test-key'
    const config = await (await import('../src/config.ts')).loadChatConfig(ws)
    delete process.env.MOCK_KEY

    const courseId = basename(ws)
    const callsBefore = llmCallCount

    // 第一个 requestId
    let sid = ''
    for await (const event of chatStream(ws, courseId, { message: '问题一', mode: 'socratic', requestId: 'req_A' }, config)) {
      if (event.kind === 'meta') sid = String(event.payload['sessionId'])
    }
    expect(llmCallCount).toBe(callsBefore + 1)

    // 不同 requestId → 新 turn，再次请求 LLM
    for await (const event of chatStream(ws, courseId, { message: '问题二', mode: 'socratic', requestId: 'req_B', sessionId: sid }, config)) {
      void event
    }
    expect(llmCallCount).toBe(callsBefore + 2)

    // 两个 turn
    const sessions = await listSessions(ws, courseId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.turns).toBe(2)

    await rm(root, { recursive: true, force: true })
  })

  it('RV-15：并发同 requestId 重试只新开一个 turn（旧实现双发：重复 user/input + 双倍计费）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-idempotent-race-'))
    const ws = join(root, 'ws')
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    await writeFile(join(ws, 'overview.md'), '# 多态\n\n重载与覆写。\n', 'utf8')
    await writeFile(join(ws, 'syllabus.json'), JSON.stringify({
      course_id: basename(ws), title: '多态', version: '1.0.0',
      chapters: [{ id: 'chap_1', title: '继承', concepts: [{ id: 'c_1', name: '重载与覆写' }] }],
    }), 'utf8')
    await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: mock',
      '  model: mock-model',
      '  api_key_env: MOCK_KEY',
      `  api_base: ${baseUrl}`,
      '  temperature: 0.3',
      '  max_concurrency: 1',
      'ui:',
      '  default_mode: socratic',
      '',
    ].join('\n'), 'utf8')

    process.env.MOCK_KEY = 'test-key'
    const config = await (await import('../src/config.ts')).loadChatConfig(ws)
    delete process.env.MOCK_KEY

    const courseId = basename(ws)
    const requestId = 'req_race_test_001'
    // 共享 registry：并发调用复用同一 Agent，排除"各自 restore 重泵"的干扰。
    const registry = new AgentRegistry()

    // 预置「有部分可见输出的取消回合」事件日志：Agent 只对零可见输出的失败
    // 回合自动 input/voided，取消回合保留 assistant/message 且不 void——重试
    // 因此走 chatStream 的 UI-15 新开路径，RV-15 的并发双发竞态在该形态下
    // 真实存在（直接预置比驱动真实取消更确定，不受适配器 abort 语义影响）。
    const sid = '20260927-120000'
    const seedStore = new SessionEventStore(join(ws, '.studyclaw', 'history'))
    const ts = (offset: number): string => new Date(Date.UTC(2026, 8, 27, 12, 0, offset)).toISOString()
    await seedStore.append(sid,
      { ts: ts(0), type: 'session/create', payload: { mode: 'socratic', agentId: `study-${sid}` } },
      { ts: ts(1), type: 'inbox/queued', payload: { turnId: 'turn-1', target: 'next-turn', content: '解释覆写' } },
      { ts: ts(2), type: 'inbox/dequeued', payload: { turnId: 'turn-1', target: 'next-turn', content: '解释覆写' } },
      { ts: ts(3), type: 'user/input', payload: { content: '解释覆写', requestId, turnId: 'turn-1' } },
      { ts: ts(4), type: 'turn/start', payload: { mode: 'socratic', target: 'next-turn', turnId: 'turn-1' } },
      { ts: ts(5), type: 'assistant/message', payload: { content: '部分输出', turnId: 'turn-1' } },
      { ts: ts(6), type: 'turn/cancelled', payload: { reason: 'user', turnId: 'turn-1' } },
    )
    const callsBefore = llmCallCount

    // 两个并发同 requestId 重试（模拟 SSE 断连自动重试与手动重试重叠）。
    const drain = async (): Promise<void> => {
      for await (const _event of chatStream(ws, courseId, { message: '解释覆写', mode: 'socratic', requestId, sessionId: sid }, config, registry)) {
        void _event
      }
    }
    await Promise.all([drain(), drain()])

    // LLM 侧：最多 2 次（1 次新 turn + 1 次 firstPrompt 的 LLM 标题生成）。
    // 旧实现两个并发都 agent.send → 至少 3 次（双 turn + 标题）。
    expect(llmCallCount).toBeLessThanOrEqual(callsBefore + 2)
    // 精确断言在事件日志：该 requestId 的 user/input 共 2 条（取消原帖 + 重试
    // 新帖）；input/voided 只补写 1 次（旧实现两个并发都基于同一旧快照通过
    // "未 void" 检查 → 双发双计费 + 双 void）。
    const rows = await new SessionEventStore(join(ws, '.studyclaw', 'history')).load(sid)
    expect(rows.filter(row => row.type === 'user/input' && row.payload['requestId'] === requestId)).toHaveLength(2)
    expect(rows.filter(row => row.type === 'input/voided')).toHaveLength(1)

    await rm(root, { recursive: true, force: true })
  })

  it('RV-22：入场即已中止的请求不发起回合（死连接不白跑 LLM）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-idempotent-preabort-'))
    const ws = join(root, 'ws')
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    await writeFile(join(ws, 'overview.md'), '# 多态\n\n重载与覆写。\n', 'utf8')
    await writeFile(join(ws, 'syllabus.json'), JSON.stringify({
      course_id: basename(ws), title: '多态', version: '1.0.0',
      chapters: [{ id: 'chap_1', title: '继承', concepts: [{ id: 'c_1', name: '重载与覆写' }] }],
    }), 'utf8')
    await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: mock',
      '  model: mock-model',
      '  api_key_env: MOCK_KEY',
      `  api_base: ${baseUrl}`,
      '  temperature: 0.3',
      '  max_concurrency: 1',
      'ui:',
      '  default_mode: socratic',
      '',
    ].join('\n'), 'utf8')

    process.env.MOCK_KEY = 'test-key'
    const config = await (await import('../src/config.ts')).loadChatConfig(ws)
    delete process.env.MOCK_KEY

    const controller = new AbortController()
    controller.abort()
    const before = llmCallCount
    const kinds: string[] = []
    for await (const event of chatStream(ws, basename(ws), { message: '解释覆写', mode: 'socratic', requestId: 'req_pre_abort_001', signal: controller.signal }, config)) {
      kinds.push(event.kind)
    }
    // 不请求 LLM、不产出任何帧、不落 user/input（旧实现 abort() 后仍 send+跑完整 turn）。
    expect(llmCallCount).toBe(before)
    expect(kinds).toEqual([])
    const sessions = await listSessions(ws, basename(ws))
    expect(sessions.every(session => session.turns === 0)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})