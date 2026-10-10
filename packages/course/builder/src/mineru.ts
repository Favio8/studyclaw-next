/**
 * MinerU sidecar（PRD 需求一）：可选的本地 PDF/Office 解析引擎。
 *
 * MinerU 是 Python 程序（`mineru-kit parse <file> -o <out>.md`，无状态模式
 * 默认解析全部页），不能进 npm Bundle，因此以独立进程按需调用：
 * - 探测：PATH → `~/.local/bin`（Windows 上 uv 工具 shim 目录，默认不进
 *   PATH）→ `uv tool list`。`.cmd/.bat`（全局 pip 安装）刻意不接：Node
 *   安全策略禁止无 shell 执行 .cmd，命中也当未安装并引导装 uv/pipx
 *   （它们落 .exe shim，可直接 execFile）。
 * - 调用：`execFile` 数组参数、无 shell、windowsHide、超时 kill；
 * - 失败分五类（未安装 / 启动失败 / 非零退出 / 超时 / 空输出），全部抛
 *   `MineruError`，由 extract 层回落到内置 pdf-parse。
 *
 * 隐私：只用本地 CLI，Host 不把文档发往网络；MinerU 自身遥记由设置页
 * 提供 `mineru telemetry disable` 开关关闭。
 * @module @studyclaw/course-builder/src/mineru
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 解析引擎开关：auto=探测到 mineru-kit 则用它，否则内置；mineru=强制（缺失即降级）；builtin=只用内置。 */
export type ParseEngine = 'auto' | 'mineru' | 'builtin'

/** MinerU 质量档（flash 仅预览，不开放给课程构建）。 */
export type MineruTier = 'basic' | 'standard' | 'advanced'

export interface ParseEngineOptions {
  readonly engine: ParseEngine
  readonly tier: MineruTier
  readonly timeoutSec: number
  /** 同时解析进程数上限（1~2）。摄取阶段当前按文件串行，该值作为未来
   *  并行化时的上限保留；每个 mineru-kit 进程各自加载模型，内存敏感。 */
  readonly concurrency: number
}

export const DEFAULT_PARSE_OPTIONS: ParseEngineOptions = {
  engine: 'auto',
  tier: 'basic',
  timeoutSec: 300,
  concurrency: 1,
}

export type MineruFailureCode = 'not-installed' | 'spawn-failed' | 'nonzero-exit' | 'timeout' | 'empty-output'

export class MineruError extends Error {
  constructor(readonly code: MineruFailureCode, message: string) {
    super(message)
    this.name = 'MineruError'
  }
}

export interface MineruProbe {
  readonly available: boolean
  /** 探测到的可执行文件（绝对路径或 PATH 名）；不可用为 null。 */
  readonly command: string | null
  readonly reason: MineruFailureCode | null
}

const PROBE_TTL_MS = 30_000
let probeCache: { at: number; result: MineruProbe } | null = null

const UNAVAILABLE: MineruProbe = { available: false, command: null, reason: 'not-installed' }

/** 可执行候选名：Windows 只认 .exe（uv/pipx 的 shim 形态）；无扩展名候选
 *  仅 POSIX 有效——Windows 上 execFile 一个无扩展名文件必然 ENOENT，把它
 *  算进探测等于报"已安装"却起不来。 */
function candidateNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`] : [base]
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

/** 在 PATH 目录里按候选名找可执行文件（纯 fs，不起进程）；命中返回绝对路径。 */
async function findOnPath(base: string): Promise<string | null> {
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const dir of (process.env.PATH ?? '').split(separator).filter(dir => dir !== '')) {
    for (const name of candidateNames(base)) {
      const candidate = join(dir, name)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}

/** `~/.local/bin`（uv 在 Windows 的默认 shim 目录，通常不在 PATH）。 */
async function findInLocalBin(base: string): Promise<string | null> {
  for (const name of candidateNames(base)) {
    const candidate = join(homedir(), '.local', 'bin', name)
    if (await isFile(candidate)) return candidate
  }
  return null
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(new Error(error.message, { cause: error }), { code: error.code, killed: (error as { killed?: boolean }).killed, stderr }))
          return
        }
        resolve()
      },
    )
  })
}

/** `uv tool list` 输出里出现 mineru 即视为已安装（uv 是 Go 二进制，启动快）。 */
async function uvToolListHasMineru(): Promise<boolean> {
  const uv = await findOnPath('uv')
  if (uv === null) return false
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(uv, ['tool', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null) reject(error)
        else resolve({ stdout })
      })
    })
    return /mineru/i.test(stdout)
  } catch {
    return false
  }
}

/**
 * 探测 mineru-kit 是否可用（结果缓存 30s；设置变更后调用方传 refresh）。
 * 顺序：PATH → ~/.local/bin → uv tool list。
 */
export async function probeMineru(options: { refresh?: boolean } = {}): Promise<MineruProbe> {
  if (!options.refresh && probeCache !== null && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.result
  }
  let result: MineruProbe = UNAVAILABLE
  const onPath = await findOnPath('mineru-kit')
  if (onPath !== null) {
    result = { available: true, command: onPath, reason: null }
  } else {
    const inLocalBin = await findInLocalBin('mineru-kit')
    if (inLocalBin !== null) {
      result = { available: true, command: inLocalBin, reason: null }
    } else if (await uvToolListHasMineru()) {
      // uv 已装 mineru 但 shim 不在常见位置：仍以 PATH 名调用，uv 的 shim
      // 目录由 uv 自己解析（Windows 为 ~/.local/bin，POSIX 同）。
      result = { available: true, command: 'mineru-kit', reason: null }
    }
  }
  probeCache = { at: Date.now(), result }
  return result
}

/** 设置变更/测试用：清掉探测缓存。 */
export function resetMineruProbeCache(): void {
  probeCache = null
}

/**
 * 用 MinerU 解析单个文件为 Markdown。任何失败抛 MineruError（调用方回落
 * 内置解析）。临时产物目录由本函数自行创建与清理。
 */
export async function parseWithMineru(
  sourcePath: string,
  tier: MineruTier,
  timeoutSec: number,
): Promise<string> {
  const probe = await probeMineru()
  if (!probe.available || probe.command === null) {
    throw new MineruError('not-installed', '未探测到 mineru-kit（可用 uv tool install "mineru>=4.0,<5" 安装）')
  }
  const workDir = await mkdtemp(join(tmpdir(), 'studyclaw-mineru-'))
  const outFile = join(workDir, 'out.md')
  try {
    try {
      await runCommand(
        probe.command,
        // 不传 --pages：mineru-kit 无状态模式默认即全部页；--pages 属于
        // 文档库模式 mineru parse（默认前 10 页），不是同一个入口。
        ['parse', sourcePath, '-o', outFile, '--tier', tier],
        Math.max(1, timeoutSec) * 1000,
      )
    } catch (error) {
      const failure = error as { code?: string; killed?: boolean; stderr?: string }
      if (failure.killed === true) {
        throw new MineruError('timeout', `MinerU 解析超时（>${timeoutSec}s）: ${sourcePath}`)
      }
      if (failure.code === 'ENOENT') {
        throw new MineruError('spawn-failed', `mineru-kit 启动失败: ${probe.command}`)
      }
      throw new MineruError('nonzero-exit', `MinerU 解析失败: ${(failure.stderr ?? '').trim().slice(0, 500) || String(error)}`)
    }
    const markdown = await readFile(outFile, 'utf8').catch(() => '')
    if (markdown.trim() === '') {
      throw new MineruError('empty-output', `MinerU 未产出可检索文本: ${sourcePath}`)
    }
    return markdown
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {
      // 临时目录清理失败不影响解析结果。
    })
  }
}
