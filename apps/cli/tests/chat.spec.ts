/**
 * `studyclaw chat` 命令测试（对齐 Python test_cli_chat 断言语义）：
 * REPL 流式直打、<think> 零泄漏（仅一行 [思考中…]）、ask 应答续流、
 * /exit 退出提示、--turns/单发、最近会话恢复、tool 摘要、非法 mode。
 */

import { describe, expect, it } from 'vitest'
import { UsageError } from '../src/lib/args.ts'
import { chatCommand, runChat } from '../src/commands/chat.ts'
import type { SseFrame } from '../src/lib/client.ts'
import { capture, fakeRpc, SINGLE_WORKSPACE, testTerminal } from './helpers.ts'

function chatStreamFactory(frames: SseFrame[] | ((payload: Record<string, unknown>) => SseFrame[])) {
  const calls: Record<string, unknown>[] = []
  const stream = async function* (payload: Record<string, unknown>): AsyncGenerator<SseFrame> {
    calls.push(payload)
    const list = typeof frames === 'function' ? frames(payload) : frames
    for (const frame of list) yield frame
  }
  return { stream, calls }
}

function answerStreamFactory(frameSets: SseFrame[][]) {
  const calls: Array<{ agentId: string; answer: string }> = []
  const stream = async function* (payload: { agentId: string; answer: string }): AsyncGenerator<SseFrame> {
    calls.push(payload)
    const frames = frameSets.shift() ?? []
    for (const frame of frames) yield frame
  }
  return { stream, calls }
}

function chatHandlers(extra: Record<string, (payload: unknown) => unknown> = {}) {
  return {
    ...SINGLE_WORKSPACE,
    'sessions.list': () => ({ sessions: [
      { sessionId: 's1', title: '旧会话', mode: 'socratic', turns: 3, createdAt: '2026-08-20T09:00:00Z', lastActiveAt: '2026-08-22T09:00:00Z' },
    ] }),
    'sessions.create': () => ({ sessionId: 's-new', title: '新会话', mode: 'socratic' }),
    ...extra,
  }
}

describe('chat', () => {
  it('REPL：流式直打回复，思考内容零泄漏，/exit 提示自动保存', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([
      { event: 'meta', data: { sessionId: 's9', provider: 'deepseek', model: 'm1' } },
      { event: 'thinking', data: { delta: '这是不该出现的思考内容' } },
      { event: 'token', data: { delta: '你好！' } },
      { event: 'token', data: { delta: '有什么想问？' } },
      { event: 'done', data: { usage: { promptTokens: 12, completionTokens: 8 } } },
    ])
    const handlers = {
      ...chatHandlers(),
      'sessions.list': () => ({ sessions: [] }),
    }
    await runChat({ rpc: fakeRpc(handlers), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal(['你好', '/exit'], cap) }, {
      mode: 'socratic', newSession: false, initialMessage: null, turns: null,
    })

    const text = cap.text()
    expect(text).toContain('STUDYCLAW // TUTOR SESSION')
    expect(text).toContain('[思考中…]')
    expect(text).toContain('你好！有什么想问？')
    expect(text).not.toContain('不该出现的思考内容')
    expect(text).toContain('会话已自动保存')
    expect(text).toContain('输入 12 · 输出 8 tokens')
    expect(fakeChat.calls[0]?.message).toBe('你好')
    expect(fakeChat.calls[0]?.sessionId).toBeUndefined()
  })

  it('默认恢复最近会话：chatStream 携带 sessions.list 最新 sessionId', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([{ event: 'done', data: {} }])
    await runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal(['你好', ':quit'], cap) }, {
      mode: 'quick', newSession: false, initialMessage: null, turns: null,
    })
    expect(fakeChat.calls[0]?.sessionId).toBe('s1')
    expect(cap.text()).toContain('会话 s1')
  })

  it('--new 不恢复、单发 --turns 1 后直接退出', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([
      { event: 'meta', data: { sessionId: 's5' } },
      { event: 'token', data: { delta: '单发回答' } },
      { event: 'done', data: {} },
    ])
    await runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal([], cap) }, {
      mode: 'socratic', newSession: true, initialMessage: '你好', turns: 1,
    })
    expect(cap.text()).toContain('单发回答')
    expect(cap.text()).toContain('会话已自动保存')
    expect(fakeChat.calls[0]?.message).toBe('你好')
    expect(fakeChat.calls[0]?.sessionId).toBe('s-new')
  })

  it('ask 帧：终端内应答并经 answer/stream 续流', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([
      { event: 'meta', data: { sessionId: 's1' } },
      { event: 'token', data: { delta: '我需要确认一下。' } },
      { event: 'ask', data: { question: '请解释 Filter 的作用？' } },
    ])
    const fakeAnswer = answerStreamFactory([
      [
        { event: 'meta', data: { sessionId: 's1' } },
        { event: 'token', data: { delta: '好的，Filter 用于筛选。' } },
        { event: 'done', data: { usage: {} } },
      ],
    ])
    await runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: fakeAnswer.stream, terminal: testTerminal(['你好', '我的解释', '/exit'], cap) }, {
      mode: 'socratic', newSession: false, initialMessage: null, turns: null,
    })
    expect(cap.text()).toContain('请解释 Filter 的作用？')
    expect(fakeAnswer.calls).toEqual([{ agentId: 'study-s1', answer: '我的解释' }])
    expect(cap.text()).toContain('好的，Filter 用于筛选。')
  })

  it('tool 帧打印工具摘要行', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([
      { event: 'meta', data: { sessionId: 's1' } },
      { event: 'tool-start', data: { callId: 'c1', name: 'read_source', args: { path: 'x.md' } } },
      { event: 'tool', data: { payload: { file: 'x.md', lines: 2 } } },
      { event: 'token', data: { delta: '读完了。' } },
      { event: 'done', data: {} },
    ])
    await runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal(['你好', '/exit'], cap) }, {
      mode: 'debug', newSession: false, initialMessage: null, turns: null,
    })
    expect(cap.text()).toContain('🔧 read_source')
    expect(cap.text()).toContain('读完了。')
  })

  it('EOF 输入耗尽视为退出并提示自动保存', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([{ event: 'done', data: {} }])
    await runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal([], cap) }, {
      mode: 'socratic', newSession: false, initialMessage: null, turns: null,
    })
    expect(cap.text()).toContain('会话已自动保存')
    expect(fakeChat.calls).toHaveLength(0)
  })

  it('error 帧：LLM_NOT_CONFIGURED 转中文提示', async () => {
    const cap = capture()
    const fakeChat = chatStreamFactory([
      { event: 'error', data: { code: 'LLM_NOT_CONFIGURED', message: 'LLM_NOT_CONFIGURED' } },
    ])
    await expect(runChat({ rpc: fakeRpc(chatHandlers()), chatStream: fakeChat.stream, answerStream: answerStreamFactory([]).stream, terminal: testTerminal(['你好'], cap) }, {
      mode: 'socratic', newSession: false, initialMessage: null, turns: null,
    })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
  })

  it('非法 --mode：UsageError', async () => {
    await expect(chatCommand(['--mode', 'bad'])).rejects.toBeInstanceOf(UsageError)
  })
})
