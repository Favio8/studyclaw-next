/**
 * Shared test scaffolding for CLI command tests: scripted stdin prompts
 * (exhausted → EndOfInput), an output capture sink, and fixture builders for
 * the fake rpc/eval/chat streams. All rendering runs with tty=false so
 * assertions match plain text.
 * @module apps/cli/tests/helpers
 */

import { EndOfInput, makeTerminal, type PromptFn, type TextSink, type Terminal } from '../src/lib/terminal.ts'
import type { RpcFn, SseFrame } from '../src/lib/client.ts'
import type { QuizTaskView } from '../src/commands/quiz.ts'

/** 脚本化 prompt：从列表取行，耗尽抛 EndOfInput（与真实 EOF/Ctrl-C 同语义）。 */
export function scriptedPrompt(inputs: string[]): PromptFn {
  return () => {
    const next = inputs.shift()
    return next === undefined ? Promise.reject(new EndOfInput()) : Promise.resolve(next)
  }
}

export interface Capture {
  sink: TextSink
  text(): string
  lines(): string[]
}

export function capture(): Capture {
  const lines: string[] = []
  return {
    sink: {
      write: text => lines.push(text),
      line: (text = '') => lines.push(text),
    },
    text: () => lines.join(''),
    lines: () => lines,
  }
}

/** 非 TTY 测试终端：注入脚本化输入与捕获输出。 */
export function testTerminal(inputs: string[], cap: Capture): Terminal {
  return makeTerminal({ tty: false, sink: cap.sink, prompt: scriptedPrompt(inputs) })
}

/** 按方法名分发的 fake RPC。 */
export function fakeRpc(handlers: Record<string, (payload: unknown) => unknown>): RpcFn {
  return async <T>(method: string, payload: unknown): Promise<T> => {
    const handler = handlers[method]
    if (handler === undefined) throw new Error(`Unexpected rpc: ${method}`)
    return handler(payload) as T
  }
}

/** 固定工作区/课程 fixture（唯一课程）。 */
export const SINGLE_WORKSPACE = {
  'workspaces.list': () => ({ current: 'D:/ws' }),
  'workspaces.courses': () => ({
    courses: [{ id: 'c1', title: 'Demo Course', overallMastery: 0.4, dueToday: 2, lastActiveAt: '2026-08-23T10:00:00Z' }],
    missing: false,
  }),
}

export function quizTask(overrides: Partial<QuizTaskView> = {}): QuizTaskView {
  return {
    taskId: 't_001',
    conceptId: 'c_filter',
    type: 'concept',
    difficulty: 2,
    question: 'Filter eliminates nodes first?',
    options: null,
    ...overrides,
  }
}

const PASS_FRAMES: SseFrame[] = [
  { event: 'scan', data: { phase: 'rubric' } },
  { event: 'rubric', data: { index: 0, criterion: '给出 Filter 的作用', hit: true } },
  { event: 'rubric', data: { index: 1, criterion: '说明 Score 的作用', hit: true } },
  { event: 'result', data: { score: 1, passed: true, feedback: '回答得很好', misconceptions: [] } },
  { event: 'sm2', data: { ef: 2.5, efNew: 2.6, nextReviewAt: '2026-08-25T00:00:00.000Z', masteryDelta: 0.5 } },
  { event: 'done', data: { taskId: 't_001' } },
]

/** 返回一个可计数的 eval 帧流（可变帧序列，默认全中通过）。 */
export function evalStreamFactory(frames: SseFrame[] = PASS_FRAMES): {
  stream: (payload: { courseId: string; taskId: string; answer: string; sessionId: string | null }) => AsyncIterable<SseFrame>
  calls: Array<{ taskId: string; answer: string }>
} {
  const calls: Array<{ taskId: string; answer: string }> = []
  return {
    stream: async function* (payload) {
      calls.push({ taskId: payload.taskId, answer: payload.answer })
      for (const frame of frames) yield frame
    },
    calls,
  }
}
