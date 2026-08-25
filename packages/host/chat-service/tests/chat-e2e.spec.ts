/**
 * Chat e2e: a mock OpenAI-compatible SSE server behind the REAL dsh
 * DeepSeekAdapter (serialize/SSE/translate), driving the full tool loop
 * through TutorSession/chatStream. This is the test that pins the LLM wire
 * integration without a real API key.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,  join } from 'node:path'
import { createDeepSeekToolClient } from '../src/adapter.ts'
import { chatStream, listSessions, searchSessions } from '../src/service.ts'
import type { ResolvedChatConfig } from '../src/config.ts'
import type { ToolCall } from '@studyclaw/session'

/** Stream one OpenAI chat.completion.chunk sequence over the response. */
function sse(res: import('node:http').ServerResponse, chunks: string[]): void {
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

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body) as { messages?: Array<{ role: string }> }
      const hasToolResult = (payload.messages ?? []).some(message => message.role === 'tool')
      if (hasToolResult) {
        // Second round: answer with text (no tool calls).
        sse(res, [{ content: '资料里写了：' }, { content: '重载是同名不同参数，覆写是重定义。' }])
        return
      }
      // First round: emit text then a read_source tool call.
      sse(res, [
        { content: '<think>先看资料。</think>' },
        { content: '让我查一下资料。' },
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_mock_1',
              type: 'function',
              function: { name: 'read_source', arguments: JSON.stringify({ path: 'overview.md' }) },
            },
          ],
        },
      ])
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

describe('DeepSeekAdapter tool client (mock OpenAI server)', () => {
  it('streams text deltas and the tool-call batch', async () => {
    const config = { ...mockConfig, baseUrl }
    const client = createDeepSeekToolClient(config)
    const deltas: string[] = []
    let calls: ToolCall[] = []
    for await (const event of client.request('system', [{ role: 'user', content: '什么是覆写' }], [{
      type: 'function',
      function: { name: 'read_source', description: '读资料', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    }])) {
      if (event.kind === 'text') deltas.push(event.delta)
      else calls = event.calls
    }
    expect(deltas.join('')).toContain('让我查一下资料。')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('read_source')
    expect(calls[0]!.arguments).toEqual({ path: 'overview.md' })
  })
})

describe('chatStream e2e (config + tools + persistence)', () => {
  it('runs a full tool-loop turn and lists the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-chat-e2e-'))
    const ws = join(root, 'ws')
    const courseDir = ws
    await mkdir(join(ws, '.studyclaw'), { recursive: true })
    await writeFile(join(courseDir, 'overview.md'), '# 多态\n\n## 重载与覆写\n\n重载是同名不同参数；覆写是重定义。\n', 'utf8')
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
    expect(config.model).toBe('mock-model')
    expect(config.baseUrl).toBe(baseUrl)
    expect(config.apiKey).toBe('test-key')

    const events: string[] = []
    const meta = { sessionId: '' }
    for await (const event of chatStream(ws, basename(ws), { message: '解释一下覆写', mode: 'socratic' }, config)) {
      if (event.kind === 'meta') meta.sessionId = String(event.payload['sessionId'])
      events.push(event.kind)
      if (event.kind === 'tool') {
        // The tool event payload name must be the executed read_source.
        expect(event.payload['name']).toBe('read_source')
        expect(event.payload['callId']).toBe('call_mock_1')
      }
      if (event.kind === 'tool-start') {
        expect(event.payload.name).toBe('read_source')
        expect(event.payload.callId).toBe('call_mock_1')
      }
    }
    expect(meta.sessionId).not.toBe('')
    expect(events).toContain('token')
    expect(events).toContain('tool')
    expect(events.filter(kind => kind === 'token').length).toBeGreaterThanOrEqual(2)

    const sessions = await listSessions(ws, basename(ws))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.turns).toBe(1)
    expect(sessions[0]!.title).toBe('解释一下覆写')
    const matches = await searchSessions(ws, basename(ws), '重载')
    expect(matches).toMatchObject([{ sessionId: meta.sessionId, match: 'content', snippet: expect.stringContaining('重载') }])
    await rm(root, { recursive: true, force: true })
  })
})
