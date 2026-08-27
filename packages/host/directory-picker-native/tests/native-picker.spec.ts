/**
 * Native picker tier selection (Windows-only subset). The Win32 dialog is the
 * single tier: success maps to the path, cancellation to null, and any
 * failure surfaces as-is with no fallback. Non-Windows hosts resolve null
 * (the browse backend is the composition-level fallback). When the caller
 * supplies no signal, an internal 240 s timeout-bound lifetime stands in so
 * a forgotten dialog cannot dangle the RPC.
 */

import { describe, expect, it, vi } from 'vitest'
import { pickNativeDirectory } from '../src/native-picker.ts'

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

  it('resolves null off-Windows (the browse backend is the only path there)', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'darwin' })).resolves.toBeNull()
    await expect(pickNativeDirectory(signal(), { platform: 'linux' })).resolves.toBeNull()
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).resolves.toBeNull()
  })

  it('uses the current process platform when no override is supplied', async () => {
    // Deterministic on every host: win32 answers from the injected dialog,
    // other platforms short-circuit to null.
    const pickWin32Dialog = async (): Promise<string | null> => 'C:\\default\\platform'
    const expected = process.platform === 'win32' ? 'C:\\default\\platform' : null
    await expect(pickNativeDirectory(signal(), { pickWin32Dialog })).resolves.toBe(expected)
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
