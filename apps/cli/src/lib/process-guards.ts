/**
 * Process-level last-resort guards.
 *
 * Node >=15 defaults `unhandled-rejections` to `throw`, so a single stray
 * rejection anywhere in this single-process Host kills the server and with
 * it every open UI tab. For a local, single-user tool that is the wrong
 * trade: one unawaited fire-and-forget should be loud in the log, not fatal.
 *
 * Deliberate choices:
 * - `unhandledRejection` logs and keeps running. The rejection is still
 *   reported; nothing is silently swallowed.
 * - `uncaughtException` logs and then exits 1, preserving Node's default
 *   "this process is no longer trustworthy" semantics rather than limping on
 *   in a state nobody has characterised.
 *
 * Everything goes to stderr via console.error. `studyclaw acp` speaks NDJSON
 * on stdout, so writing diagnostics there would corrupt the protocol stream
 * (same reason host-logger skips its stdout tee outside `serve`).
 * @module apps/cli/lib/process-guards
 */

let installed = false

export function installProcessGuards(): void {
  if (installed) return
  installed = true

  process.on('unhandledRejection', (reason) => {
    console.error('[studyclaw] 未处理的 Promise 拒绝（已记录，服务继续运行）:', describe(reason))
  })

  process.on('uncaughtException', (error) => {
    console.error('[studyclaw] 未捕获异常，进程即将退出:', describe(error))
    process.exit(1)
  })
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}