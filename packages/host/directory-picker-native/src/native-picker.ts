/**
 * StudyClaw native directory picker — cross-platform tiered subset of the dsh
 * `directory-picker-native` backend (MIT). FL-45：不再只保留 Win32 一层——
 * macOS 走 `osascript choose folder`，Linux 走 `zenity`（缺则回落 `kdialog`），
 * Windows 保留 koffi 驱动的 `IFileOpenDialog` 子进程（前台激活语义见
 * win32-dialog.ts）。三层都不可用时抛"不可用"错误，由调用方回落 browse 后端。
 */

import { pickWin32Directory } from './win32-dialog.ts'
import { runNativeCommand, type NativeCommandRunner } from './native-command.ts'

/** Injectable platform facts for deterministic tests. */
export interface DirectoryPickerInternals {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Replaces the no-shell command runner (osascript/zenity/kdialog) for tests. */
  run?: NativeCommandRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

/**
 * Cancellation-friendly max wall-clock for one pick when the caller supplies
 * no signal. Matches the legacy PowerShell `execFile` timeout so a forgotten
 * dialog cannot dangle the RPC.
 */
const PICK_TIMEOUT_MS = 240_000

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort closes the dialog or
 *   terminates the native command. When omitted (the StudyClaw host path,
 *   which has no signal plumbing through `dispatch`), a fresh controller with
 *   a 240 s timeout stands in so a forgotten dialog cannot dangle the RPC.
 * @param internals - platform, runner and dialog hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 * @throws when no native picker tier is available on the host platform
 *   (missing osascript/zenity/kdialog, or a non-desktop OS). The caller must
 *   distinguish "cancel" (null) from "unavailable" (throw) — FL-02：旧实现
 *   两者都返回 null，向导把"不可用"当"取消"直接关窗，首启死锁。
 */
export async function pickNativeDirectory(
  signal?: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  // The caller has no signal: stand up an internal timeout-bound lifetime so
  // a forgotten dialog self-aborts instead of hanging the RPC.
  if (signal !== undefined) return pickWithPlatform(platform, signal, internals)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), PICK_TIMEOUT_MS)
  try {
    return await pickWithPlatform(platform, controller.signal, internals)
  } finally {
    clearTimeout(timer)
  }
}

async function pickWithPlatform(
  platform: NodeJS.Platform,
  signal: AbortSignal,
  internals: DirectoryPickerInternals,
): Promise<string | null> {
  if (platform === 'win32') {
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return pickDialog(signal)
  }
  if (platform === 'darwin') {
    const run = internals.run ?? runNativeCommand
    try {
      const result = await run('osascript', [
        '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
        '-e', 'POSIX path of selectedFolder',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      // 用户取消：osascript 退出码 1 + stderr 命中 User canceled/-128 → null。
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }
  if (platform === 'linux') {
    const run = internals.run ?? runNativeCommand
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', '--title=Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }
    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        // FL-45：三层皆不可用 → "不可用"错误（消息包含向导识别的
        // 「原生目录选择器」关键词，前端自动回落目录浏览）。
        throw new Error('未找到可用的原生目录选择器（可安装 zenity 或 kdialog）：请改用目录浏览选择项目')
      }
      throw error
    }
  }
  throw new Error('当前平台没有原生目录选择器（仅 Windows/macOS/Linux 桌面支持）：请改用目录浏览选择项目')
}
