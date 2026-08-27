/**
 * `studyclaw chat` — interactive tutoring REPL over `/api/chat/stream`:
 * hidden thinking (a single "[思考中…]" hint, no deltas), live token output,
 * tool-call summaries, ask-frame answers resumed through
 * `/api/agents/answer/stream`, sync hints, and done usage lines. Exits via
 * /exit | /quit | :quit, Ctrl-C or EOF, always ending with the auto-save
 * notice. Session selection: --new | --session <id> | most-recent (auto).
 * @module @studyclaw/cli/commands/chat
 */

import { CliError, hostRpc, streamAgentAnswer, streamChat, type RpcFn, type SseFrame } from '../lib/client.ts'
import { EndOfInput, makeTerminal, type Terminal } from '../lib/terminal.ts'
import { parseArgs, UsageError } from '../lib/args.ts'
import { resolveCourse } from './course.ts'

const MODES = ['socratic', 'quick', 'feynman', 'debug'] as const
export type LearningMode = typeof MODES[number]

const MODE_LABELS: Record<LearningMode, string> = {
  socratic: '苏格拉底引导',
  quick: '快速直答',
  feynman: '费曼解释',
  debug: '调试诊断',
}

interface SessionSummary {
  sessionId: string
  title: string
  mode: string
  turns: number
  createdAt: string
  lastActiveAt: string | null
}

export interface ChatOptions {
  courseId?: string | null
  conceptId?: string | null
  mode: LearningMode
  sessionId?: string | null
  newSession: boolean
  initialMessage: string | null
  turns: number | null
}

export interface ChatDeps {
  rpc: RpcFn
  chatStream: (payload: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<SseFrame>
  answerStream: (payload: { agentId: string; answer: string }, signal?: AbortSignal) => AsyncIterable<SseFrame>
  terminal: Terminal
}

export async function runChat(deps: ChatDeps, options: ChatOptions): Promise<void> {
  const { rpc, terminal: t } = deps
  const course = await resolveCourse({ rpc, terminal: t }, options.courseId ?? null)

  let sessionId: string | null = null
  if (options.newSession) {
    // TutorSession 对空 sessionId 的语义是"恢复最近"；新对话必须显式创建。
    const created = await rpc<{ sessionId: string; title: string }>('sessions.create', {
      courseId: course.id,
      mode: options.mode,
      title: null,
    })
    sessionId = created.sessionId
  } else {
    sessionId = options.sessionId ?? null
  }
  if (sessionId === null && !options.newSession) {
    const { sessions } = await rpc<{ sessions: SessionSummary[] }>('sessions.list', { courseId: course.id })
    const latest = sessions
      .filter(item => item.sessionId !== '')
      .sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))[0]
    sessionId = latest?.sessionId ?? null
  }

  t.title('TUTOR SESSION')
  t.line(`${t.dim('课程')} ${course.title}（${course.id}） · ${t.dim('模式')} [${MODE_LABELS[options.mode]}] · ${sessionId === null ? '新会话' : `会话 ${sessionId}`}`)
  t.line(t.dim('输入 /exit、/quit 或 :quit 退出；每轮自动落盘。'))
  t.blank()

  const context = {
    getSessionId: () => sessionId,
    setSessionId: (id: string) => { sessionId = id },
  }

  let turnsDone = 0
  if (options.initialMessage !== null) {
    await sendTurn(deps, course.id, options, context, options.initialMessage)
    turnsDone += 1
  }

  while (options.turns === null || turnsDone < options.turns) {
    let text: string
    try {
      text = await t.prompt('> ')
    } catch (error) {
      if (error instanceof EndOfInput) break
      throw error
    }
    if (isExitCommand(text)) break
    if (text.trim() === '') continue
    await sendTurn(deps, course.id, options, context, text)
    turnsDone += 1
  }

  t.blank()
  t.line(t.dim('会话已自动保存到 history/*.jsonl，下次见。'))
}

async function sendTurn(
  deps: ChatDeps,
  courseId: string,
  options: ChatOptions,
  context: { getSessionId: () => string | null; setSessionId: (id: string) => void },
  message: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    courseId,
    message,
    mode: options.mode,
  }
  if (context.getSessionId() !== null) payload.sessionId = context.getSessionId()
  if (options.conceptId !== null && options.conceptId !== undefined) payload.conceptId = options.conceptId
  await renderFrames(deps, context, deps.chatStream(payload))
}

/** 帧渲染循环：chat/answer 流共用（ask 时读入回答并续流恢复 Agent turn）。 */
async function renderFrames(
  deps: ChatDeps,
  context: { getSessionId: () => string | null; setSessionId: (id: string) => void },
  frames: AsyncIterable<SseFrame>,
): Promise<void> {
  const { terminal: t } = deps
  let thinkingShown = false
  for await (const frame of frames) {
    const data = frame.data as Record<string, unknown>
    switch (frame.event) {
      case 'meta': {
        const sid = data.sessionId
        if (typeof sid === 'string' && sid !== '') context.setSessionId(sid)
        const provider = typeof data.provider === 'string' ? data.provider : ''
        const model = typeof data.model === 'string' ? data.model : ''
        t.line(t.dim(`[${provider}${provider !== '' && model !== '' ? '/' : ''}${model}${data.effort !== undefined ? ` · effort ${String(data.effort)}` : ''}]`))
        break
      }
      case 'thinking':
        // 推理内容不落终端（Python CLI 同纪律），仅首次提示一行。
        if (!thinkingShown) {
          t.line(t.dim('[思考中…]'))
          thinkingShown = true
        }
        break
      case 'token':
        if (typeof data.delta === 'string' && data.delta !== '') t.write(data.delta)
        break
      case 'tool-start':
        if (typeof data.name === 'string') {
          t.write('\n')
          t.line(`${t.cyan('🔧')} ${data.name} ${summarize(data.args)}`)
        }
        break
      case 'tool':
        t.line(`${t.dim('↳')} ${summarize(data.payload)}`)
        break
      case 'ask': {
        t.line('')
        t.line(`${t.yellow('❓')} ${String(data.question ?? '')}`)
        let answer: string
        try {
          answer = await t.prompt('> 回复: ')
        } catch (error) {
          if (error instanceof EndOfInput) throw new CliError('aborted', '已退出（ask 挂起可通过 studyclaw agent answer 恢复）')
          throw error
        }
        const agentId = `study-${context.getSessionId()}`
        await renderFrames(deps, context, deps.answerStream({ agentId, answer }))
        break
      }
      case 'sync':
        t.line(t.dim('（进度已同步）'))
        break
      case 'done': {
        t.line('')
        const usage = (data.usage ?? {}) as Record<string, unknown>
        const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : null
        const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : null
        if (promptTokens !== null || completionTokens !== null) {
          t.line(t.dim(`· 完成（输入 ${String(promptTokens ?? '-')} · 输出 ${String(completionTokens ?? '-')} tokens）`))
        } else {
          t.line(t.dim('· 完成'))
        }
        break
      }
      case 'error':
        throw new CliError(String(data.code ?? 'CHAT_FAILED'), translateError(String(data.message ?? '未知错误')))
    }
  }
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = JSON.stringify(value)
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

function translateError(message: string): string {
  if (message.includes('LLM_NOT_CONFIGURED') || message.includes('未配置模型')) {
    return `${message}（可在 Web 设置中保存并激活供应商，或编辑 .studyclaw/config.yaml 的 providers + active_provider）`
  }
  return message
}

function isExitCommand(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '/exit' || trimmed === '/quit' || trimmed === ':quit'
}

/** `studyclaw chat [message] [--mode <模式>] [--course <id>] [--session <id>] [--new] [--concept <id>] [--turns N]` */
export async function chatCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const modeRaw = parsed.options.mode
  if (modeRaw !== undefined && (modeRaw === true || !MODES.includes(modeRaw as LearningMode))) {
    throw new UsageError('--mode 取值 socratic | quick | feynman | debug')
  }
  const sessionFlag = parsed.options.session
  if (sessionFlag === true) throw new UsageError('--session 需要会话 ID（可用 studyclaw sessions.list 查看）')
  const turnsRaw = parsed.options.turns
  let turns: number | null = null
  if (turnsRaw !== undefined && turnsRaw !== true) {
    turns = parseInt(String(turnsRaw), 10)
    if (!Number.isInteger(turns) || turns < 1 || turns > 1000) throw new UsageError('--turns 必须是 1..1000 的整数')
  }
  const message = parsed.positionals.join(' ').trim()
  await runChat(makeChatDeps(), {
    courseId: parsed.options.course === undefined ? null : String(parsed.options.course),
    conceptId: parsed.options.concept === undefined ? null : String(parsed.options.concept),
    mode: (modeRaw === undefined ? 'socratic' : modeRaw) as LearningMode,
    sessionId: sessionFlag === undefined ? null : String(sessionFlag),
    newSession: parsed.options.new === true,
    initialMessage: message === '' ? null : message,
    turns,
  })
}

export function makeChatDeps(): ChatDeps {
  return {
    rpc: hostRpc,
    chatStream: (payload, signal) => streamChat(payload, undefined, signal),
    answerStream: (payload, signal) => streamAgentAnswer(payload, undefined, signal),
    terminal: makeTerminal(),
  }
}
