/**
 * Native picker tier selection (Windows-only subset). The Win32 dialog is the
 * single tier: success maps to the path, cancellation to null, and any
 * failure surfaces as-is with no fallback. Non-Windows hosts THROW
 * "unavailable" (FL-02: null would be indistinguishable from a user cancel
 * and stranded first-run on macOS/Linux; the browse backend is the
 * composition-level fallback). When the caller supplies no signal, an
 * internal 240 s timeout-bound lifetime stands in so a forgotten dialog
 * cannot dangle the RPC.
 */

import { describe, expect, it, vi } from 'vitest'
import { pickNativeDirectory } from '../src/native-picker.ts'
import type { NativeCommandRunner } from '../src/native-command.ts'

const signal = (): AbortSignal => new AbortController().signal

describe('pickNativeDirectory', () => {
  it('delegates to the Win32 dialog and never spawns a command when it answers', async () => {
    const pickWin32Dialog = vi.fn(async (): Promise<string | null> => 'C:\\work\\selected')
    await expect(pickNativeDirectory(signal(), { platform: 'win32', pickWin32Dialog })).resolves.toBe('C:\\work\\selected')
    pickWin32Dialog.mockResolvedValueOnce(null)
    await expect(pickNativeDirectory(signal(), { platform: 'win32', pickWin32Dialog })).resolves.toBeNull()
    expect(pickWin32Dialog).toHaveBeenCalledTimes(2)
  })

  it('surfaces the Win32 dialog failure with no fallback', async () => {
    const pickWin32Dialog = async (): Promise<string | null> => { throw new Error('dialog unavailable') }
    await expect(pickNativeDirectory(signal(), { platform: 'win32', pickWin32Dialog }))
      .rejects.toThrow('dialog unavailable')
  })

  it('wires the real Win32 dialog as the default tier', async () => {
    // A pre-aborted signal makes the DEFAULT dialog deterministic on every
    // host: pickWin32Directory throws before spawning any worker or window.
    const abort = new AbortController()
    abort.abort()
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32' }))
      .rejects.toThrow('native directory picker aborted')
  })

  it('does not fall back when the caller aborted the dialog', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const pickWin32Dialog = async (): Promise<string | null> => { throw new Error('dialog unavailable') }
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32', pickWin32Dialog })).rejects.toThrow('dialog unavailable')
  })

  it('FL-45：darwin 走 osascript——成功回路径（POSIX path 带尾斜杠），用户取消回 null', async () => {
    const run = vi.fn(async (_c: string, _a: readonly string[], _s: AbortSignal) => ({ stdout: '/Users/m/work/\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBe('/Users/m/work/')
    const cancelRun = vi.fn(async () => {
      const failure = Object.assign(new Error('user canceled'), { code: 1, stdout: '', stderr: ' execution error: User canceled. (-128)' })
      throw failure
    })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run: cancelRun })).resolves.toBeNull()
  })

  it('FL-45：linux zenity 缺失时回落 kdialog，两者皆缺抛"不可用"', async () => {
    // 第一层 zenity ENOENT → 第二层 kdialog 成功。
    const run: NativeCommandRunner = (command, _args, _signal) => {
      if (command === 'zenity') {
        const failure = Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' })
        return Promise.reject(failure)
      }
      return Promise.resolve({ stdout: '/home/m/pick\n', stderr: '' })
    }
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBe('/home/m/pick')
    // zenity/kdialog 都不存在 → "不可用"错误（含向导识别的关键词）。
    const none: NativeCommandRunner = async (command) => {
      const failure = Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', stdout: '', stderr: '' })
      throw failure
    }
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: none })).rejects.toThrow('原生目录选择器')
  })

  it('unsupported 平台仍抛"不可用"（FL-02 语义：不可用 ≠ 取消）', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).rejects.toThrow('原生目录选择器')
  })

  it('uses the current process platform when no override is supplied', async () => {
    // Deterministic on every host: win32 answers from the injected dialog,
    // other platforms short-circuit to the "unavailable" error.
    const pickWin32Dialog = async (): Promise<string | null> => 'C:\\default\\platform'
    if (process.platform === 'win32') {
      await expect(pickNativeDirectory(signal(), { pickWin32Dialog })).resolves.toBe('C:\\default\\platform')
    } else {
      await expect(pickNativeDirectory(signal(), { pickWin32Dialog })).rejects.toThrow('原生目录选择器')
    }
  })

  it('stands up an internal timeout-bound lifetime when the caller passes no signal', async () => {
    // The injected dialog receives some AbortSignal (not the undefined the
    // caller passed) and answers normally; the internal timer is cleared.
    const seen: AbortSignal[] = []
    const pickWin32Dialog = async (abort: AbortSignal): Promise<string | null> => {
      seen.push(abort)
      return 'C:\\no\\signal'
    }
    await expect(pickNativeDirectory(undefined, { platform: 'win32', pickWin32Dialog })).resolves.toBe('C:\\no\\signal')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]!.aborted).toBe(false)
  })
})
