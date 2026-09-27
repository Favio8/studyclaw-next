/**
 * Terminal rendering helpers for the interactive CLI: dependency-free ANSI
 * colors (disabled when not a TTY), readline prompt (EOF/Ctrl-C → EndOfInput),
 * and the text-based panel conventions aligned with the Python CLI
 * (STUDYCLAW // 标题、星级、[HIT]/[MISS]、√/×）。
 * @module @studyclaw/cli/lib/terminal
 */

export class EndOfInput extends Error {
  constructor() {
    super('输入结束')
    this.name = 'EndOfInput'
  }
}

export interface TextSink {
  write(text: string): void
  line(text?: string): void
}

export type PromptFn = (question: string) => Promise<string>

export interface TerminalOptions {
  tty?: boolean
  sink?: TextSink
  prompt?: PromptFn
}

export interface Terminal extends TextSink {
  /** 非 TTY 时全部退化为纯文本。 */
  bold(text: string): string
  cyan(text: string): string
  green(text: string): string
  red(text: string): string
  yellow(text: string): string
  dim(text: string): string
  /** `STUDYCLAW // <标题>` 样式头部。 */
  title(text: string): void
  /** 分隔线。 */
  hr(): void
  blank(): void
  /** 难度星级（1..5，超界夹取）。 */
  stars(count: number): string
  warn(text: string): void
  error(text: string): void
  /** 读取一行输入；Ctrl-C / EOF 抛 EndOfInput。 */
  prompt(question: string): Promise<string>
}

const ANSI: Record<string, string> = {
  bold: '1',
  cyan: '36',
  green: '32',
  red: '31',
  yellow: '33',
  dim: '2',
}

export function makeTerminal(options: TerminalOptions = {}): Terminal {
  const tty = options.tty ?? Boolean(process.stdout.isTTY)
  const sink: TextSink = options.sink ?? {
    write: text => process.stdout.write(text),
    line: (text = '') => process.stdout.write(`${text}\n`),
  }
  const prompt = options.prompt ?? defaultPrompt
  const paint = (name: string, text: string): string => (tty ? `\x1b[${ANSI[name]}m${text}\x1b[0m` : text)

  return {
    write: (text: string) => sink.write(text),
    line: (text = '') => sink.line(text),
    bold: text => paint('bold', text),
    cyan: text => paint('cyan', text),
    green: text => paint('green', text),
    red: text => paint('red', text),
    yellow: text => paint('yellow', text),
    dim: text => paint('dim', text),
    title: text => {
      sink.line('─'.repeat(44))
      sink.line(`${paint('cyan', 'STUDYCLAW //')} ${paint('bold', text)}`)
      sink.line('─'.repeat(44))
    },
    hr: () => sink.line('─'.repeat(44)),
    blank: () => sink.line(''),
    stars: count => {
      const clamped = Math.max(1, Math.min(5, Math.round(count)))
      return `${'★'.repeat(clamped)}${'☆'.repeat(5 - clamped)}`
    },
    warn: text => sink.line(`${paint('yellow', '⚠')} ${text}`),
    error: text => sink.line(`${paint('red', '×')} ${text}`),
    prompt: question => prompt(question),
  }
}

// 手工行缓冲 stdin：readline 在「多行与 EOF 同 chunk 到达」时会把缓冲行丢弃
// 并立即 close 接口（二次 question 报 readline was closed / libuv 断言），
// 改用 data 拆行队列 + end/SIGINT 语义，交互命令（quiz 逐题、chat 逐轮）稳定复用。
let stdinQueued: string[] = []
let stdinEnded = false
let pendingPrompt: { resolve: (line: string) => void; reject: (error: unknown) => void } | null = null
let stdinWired = false

// 注册任何 SIGINT 监听器都会移除 Node 的默认终止行为。有挂起 prompt 时
// Ctrl-C 语义是"中断本次读取"（拒绝该次读取）；无挂起 prompt 时（评测逐题
// 评审、chat 流式回合等无 prompt 阶段）必须恢复终止语义，否则 Ctrl-C 被
// 静默吞掉、进程无法退出。摘掉本监听器后重发信号：其余处理器（如 serve 的
// 优雅关停）继续收到，无其余处理器时走默认终止（退出码 130）。
function onSigint(): void {
  const pending = pendingPrompt
  pendingPrompt = null
  if (pending !== null) {
    pending.reject(new EndOfInput())
    return
  }
  process.removeListener('SIGINT', onSigint)
  process.kill(process.pid, 'SIGINT')
}

function wireStdin(): void {
  if (stdinWired) return
  stdinWired = true
  process.stdin.setEncoding('utf8')
  let buffer = ''
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      deliverLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (buffer !== '') deliverLine(buffer.replace(/\r$/, ''))
    stdinEnded = true
    const pending = pendingPrompt
    pendingPrompt = null
    pending?.reject(new EndOfInput())
  })
  process.on('SIGINT', onSigint)
  process.stdin.resume()
  // C-6：resume 后 stdin 句柄常驻事件循环——交互命令（quiz/review/chat）跑完
  // 后进程永不退出（代理实测挂起；测试全部注入自定义 prompt，wireStdin 零覆盖
  // 故长期潜伏）。unref 让 stdin 不再兜底事件循环；等待输入期间由 defaultPrompt
  // 显式 ref 保证进程不提前退出。文件重定向型 stdin（fs.ReadStream）无
  // ref/unref，可选链兜底。
  ;(process.stdin as { unref?: () => void }).unref?.()
}

function deliverLine(line: string): void {
  const pending = pendingPrompt
  if (pending !== null) {
    pendingPrompt = null
    pending.resolve(line)
    return
  }
  stdinQueued.push(line)
}

/** 读取一行：EOF / Ctrl-C 抛 EndOfInput。 */
async function defaultPrompt(question: string): Promise<string> {
  wireStdin()
  process.stdout.write(question)
  const queued = stdinQueued.shift()
  if (queued !== undefined) return queued
  if (stdinEnded) throw new EndOfInput()
  // C-6：等待用户输入期间重新 ref——unref 的 stdin 不会阻止进程退出，没有
  // 这一步会在两次提问之间（无其他在途 IO 时）提前退出。结算后（resolve 与
  // reject 两条路径）再 unref，命令结束后进程可自然排空。
  const stdin = process.stdin as { ref?: () => void; unref?: () => void }
  stdin.ref?.()
  return await new Promise<string>((resolve, reject) => {
    const settle = (done: () => void): void => {
      stdin.unref?.()
      done()
    }
    pendingPrompt = {
      resolve: line => settle(() => resolve(line)),
      reject: error => settle(() => reject(error)),
    }
  })
}
