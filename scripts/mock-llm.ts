/**
 * Mock OpenAI-compatible SSE endpoint for browser e2e (no real API key).
 * First request streams a think block + text + a read_source tool call;
 * subsequent rounds (with tool results) stream the final answer.
 */

import { createServer } from 'node:http'

const port = Number(process.env.MOCK_LLM_PORT ?? 18999)

function sse(res: import('node:http').ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const frame = (chunk: unknown): void => {
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: chunk, finish_reason: null }] })}\n\n`)
  }
  frame({ role: 'assistant' })
  for (const chunk of chunks) frame(chunk)
  frame({})
  res.write('data: [DONE]\n\n')
  res.end()
}

function emitStructured(res: import('node:http').ServerResponse, payload: unknown): void {
  sse(res, [{
    tool_calls: [{
      index: 0,
      id: 'call_emit_1',
      type: 'function',
      function: { name: '_emit_structured', arguments: JSON.stringify(payload) },
    }],
  }])
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const payload = JSON.parse(body) as { messages?: Array<{ role: string }>; tools?: unknown[]; system?: string }
    const systemMessage = (payload.messages ?? []).find(message => message.role === 'system')
    const system = String(payload.system ?? systemMessage?.content ?? '')
    const hasStructuredTool = (payload.tools ?? []).some(
      tool => typeof tool === 'object' && tool !== null && (tool as { function?: { name?: string } }).function?.name === '_emit_structured',
    )
    if (hasStructuredTool) {
      if (system.includes('Rubric 判题官')) {
        emitStructured(res, {
          judgements: [
            { criterion: '要点一', hit: true },
            { criterion: '要点二', hit: true },
          ],
          feedback: '你正确说出了要点。再想想边界情况？',
          misconceptions: [],
          misattribution: '无',
        })
        return
      }
      // Task generation (出题引擎 or dynamic): emit a small valid batch.
      const title = /标题：([^\n]+)/.exec(system + (payload.messages?.[0]?.content as string ?? ''))?.[1] ?? 'Mock 概念'
      emitStructured(res, {
        tasks: [
          {
            type: 'concept',
            difficulty: 2,
            question: `关于「${title}」的核心区别是什么？`,
            options: ['重载是同名不同参数', '覆写是重定义', '两者相同', '无关'],
            evaluation_criteria: { rubric: ['要点一：说出重载定义', '要点二：说出覆写定义'], keywords: [title], misattribution_options: ['概念混淆', '推导漏洞', '边界遗漏', '无'] },
          },
        ],
      })
      return
    }
    const hasToolResult = (payload.messages ?? []).some(message => message.role === 'tool')
    if (hasToolResult) {
      sse(res, [
        { content: '先看结论：' },
        { content: '覆写（override）是子类用同名方法重定义父类行为；' },
        { content: '重载（overload）是同一类中同名不同参数。' },
        { content: '现在你自己举一个覆写的例子？' },
      ])
      return
    }
    sse(res, [
      { content: '<think>学生问的是覆写，需要先查阅课程资料。</think>' },
      { content: '让我先查一下资料再回答。' },
      {
        tool_calls: [
          { index: 0, id: 'call_mock_1', type: 'function', function: { name: 'read_source', arguments: JSON.stringify({ path: 'overview.md' }) } },
        ],
      },
    ])
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${port}/v1`)
})
