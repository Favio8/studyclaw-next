/**
 * StudyClaw native directory picker — Windows-only subset of the dsh
 * `directory-picker-native` backend (MIT). The darwin/Linux command tiers
 * (osascript/zenity/kdialog) and their `@deepseek-ai/dsh-native-command`
 * dependency are dropped: StudyClaw's host already resolves null off-Windows,
 * and the browse backend (`host.browseDirectory`) is the composition-level
 * fallback for headless hosts (see NewProjectWizard). Only the Win32
 * `IFileOpenDialog` child process remains — it is the one tier that fixes the
 * foreground-activation bug the PowerShell `FolderBrowserDialog` had (a
 * dialog spawned from a background host process is never foregrounded).
 */

import { pickWin32Directory } from './win32-dialog.ts'

/** Injectable platform facts for deterministic tests. */
export interface DirectoryPickerInternals {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Replaces the in-process Win32 dialog for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

/**
 * Cancellation-friendly max wall-clock for one pick when the caller supplies
 * no signal. Matches the legacy PowerShell `execFile` timeout so a forgotten
 * dialog cannot dangle the RPC.
 */
const PICK_TIMEOUT_MS = 240_000

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort closes the dialog. When
 *   omitted (the StudyClaw host path, which has no signal plumbing through
 *   `dispatch`), a fresh controller with a 240 s timeout stands in so a
 *   forgotten dialog cannot dangle the RPC.
 * @param internals - platform and dialog hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels (or the host is
 *   not on Windows, where the browse backend is the only path).
 */
export async function pickNativeDirectory(
  signal?: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  if (platform !== 'win32') return null

  const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
  // The caller has no signal: stand up an internal timeout-bound lifetime so
  // a dialog left open past PICK_TIMEOUT_MS self-aborts instead of hanging
  // the RPC. The Win32 driver turns the abort into a WM_CLOSE on the dialog.
  if (signal !== undefined) return pickDialog(signal)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), PICK_TIMEOUT_MS)
  try {
    return await pickDialog(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
