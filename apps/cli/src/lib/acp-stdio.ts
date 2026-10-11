/**
 * ACP stdio 传输（NDJSON over stdin/stdout）。
 *
 * 关键约束：**请求必须并发处理**。串行版本（读一行、等它跑完、再读下一行）
 * 会让一次长时间的 `session.prompt` 占住读循环，期间到达的
 * `session.cancel` 只能堆在 readline 缓冲里，直到 prompt 自己结束才被发出
 * ——而宿主 HTTP 层其实完全支持并发取消（按请求 id 存 abort controller），
 * 且 `initialize` 声明了 `cancellation: true`。串行传输等于把这个能力在
 * stdio 上悄悄废掉：卡住的 prompt 只能靠杀进程。
 *
 * stdout 写入仍然串行化：多个响应可能乱序完成，但每次 write 必须是完整
 * 一行，不能互相穿插。
 * @module apps/cli/lib/acp-stdio
 */

import { parseAcpRequest, AcpProtocolError } from '@studyclaw/acp'

export interface AcpStdioOptions {
  /** 每行一个 JSON-RPC 请求的输入流（逐行产出）。 */
  readonly lines: AsyncIterable<string>
  /** 完整 NDJSON 响应（含结尾换行）。 */
  readonly write: (text: string) => void | Promise<void>
  /** 把一个已解析请求交给宿主，返回完整响应文本。 */
  readonly send: (request: ReturnType<typeof parseAcpRequest>) => Promise<string>
  /** 同时在途的请求上限，防止对端狂发时无限开连接。 */
  readonly maxInFlight?: number
}

export async function runAcpStdio(options: AcpStdioOptions): Promise<void> {
  const maxInFlight = Math.max(1, options.maxInFlight ?? 16)

  // 写入串行链：保证不交叉。
  let writeChain: Promise<void> = Promise.resolve()
  const writeOut = (text: string): void => {
    writeChain = writeChain.then(async () => { await options.write(text) })
  }

  const inFlight = new Set<Promise<void>>()
  /** 在途数量到顶时，让出事件循环直到有请求完成。 */
  const acquire = async (): Promise<void> => {
    while (inFlight.size >= maxInFlight) {
      await Promise.race(inFlight)
    }
  }

  const handle = (line: string): void => {
    if (line.trim() === '') return
    const task = (async () => {
      try {
        const request = parseAcpRequest(JSON.parse(line) as unknown)
        writeOut(`${await options.send(request)}\n`)
      } catch (error) {
        const code = error instanceof AcpProtocolError ? error.code : -32603
        const message = error instanceof Error ? error.message : String(error)
        writeOut(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } })}\n`)
      }
    })()
    inFlight.add(task)
    // task 内部已兜住所有异常，这里只需把它移出在途集合；用 then 而非 finally
    // 避免派生出的 promise 因异常成为新的未处理拒绝。
    void task.then(
      () => { inFlight.delete(task) },
      () => { inFlight.delete(task) },
    )
  }

  for await (const line of options.lines) {
    await acquire()
    handle(line)
  }

  await Promise.allSettled(Array.from(inFlight))
  await writeChain
}