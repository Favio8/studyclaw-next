/**
 * FL-37：宿主文件日志。CLI 形态下 stdout 用户可见，问题不大；但 serve 是
 * "给别人用"的形态（未来桌面端 sidecar 的 stdout 会被丢弃），线上故障零可
 * 观测性是售后刚需。做法：tee 式接管 console.log/warn/error——业务代码里
 * 已有的 21 处 console.* 无需逐个改造，全部同步落盘到
 * `<hostHome>/logs/host-<date>.log`（按天轮转，启动时清理保留窗口之外的旧文件）。
 * @module @studyclaw/cli/lib/host-logger
 */

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 日志保留窗口（天）：按天一个文件，过期即删。 */
const LOG_RETENTION_DAYS = 14

export interface HostLogger {
  /** 日志目录绝对路径（设置面板"打开日志目录"入口用）。 */
  readonly logDir: string
  stop(): void
}

function logFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `host-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`
}

async function pruneOldLogs(logDir: string, todayPrefix: string): Promise<void> {
  const files = await readdir(logDir).catch(() => [])
  for (const name of files) {
    if (!/^host-\d{4}-\d{2}-\d{2}\.log$/.test(name) || name.startsWith(todayPrefix)) continue
    const path = join(logDir, name)
    const info = await stat(path).catch(() => null)
    if (info === null) continue
    const ageDays = (Date.now() - info.mtimeMs) / 86_400_000
    if (ageDays > LOG_RETENTION_DAYS) await unlink(path).catch(() => undefined)
  }
}

/**
 * Install the console tee. Returns a stop() handle; the tee is process-wide
 * (serve() installs it once at startup, acp/quiz 等前台命令不装——它们的
 * stdout 是协议/交互通道，不能被日志污染）。
 */
export async function installHostFileLogging(hostHome: string): Promise<HostLogger> {
  const logDir = join(hostHome, 'logs')
  await mkdir(logDir, { recursive: true })
  await pruneOldLogs(logDir, logFileName(new Date()).slice(0, 'host-YYYY-MM-DD'.length))

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  let stopped = false

  const write = async (level: string, args: unknown[]): Promise<void> => {
    if (stopped) return
    try {
      const line = args
        .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg, (_key, value) => (typeof value === 'bigint' ? String(value) : value)) ?? String(arg)))
        .join(' ')
      await appendFile(join(logDir, logFileName(new Date())), `${new Date().toISOString()} [${level}] ${line}\n`, 'utf8')
    } catch {
      // 日志写盘失败绝不反向影响业务：静默（stdout 副本仍然可见）。
    }
  }

  console.log = (...args: unknown[]) => { original.log(...args); void write('info', args) }
  console.warn = (...args: unknown[]) => { original.warn(...args); void write('warn', args) }
  console.error = (...args: unknown[]) => { original.error(...args); void write('error', args) }

  return {
    logDir,
    stop(): void {
      stopped = true
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    },
  }
}
