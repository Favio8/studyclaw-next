/**
 * Native OS directory picker for the StudyClaw host. Windows opens the modern
 * `IFileOpenDialog` in a spawned child process (a koffi-driven COM
 * conversation on the child's main thread) so the dialog is the process's
 * first window and Windows activates it without a manual foreground call —
 * the failure mode of the legacy PowerShell `FolderBrowserDialog` spawned
 * from the background host. Non-Windows hosts resolve null and rely on the
 * browse backend. Adapted from `@deepseek-ai/dsh-host-directory-picker-native`
 * (MIT): the cordis capability seam, invariant companion, and POSIX command
 * tiers are dropped to fit StudyClaw's plain-function `HostServices`.
 * @module @studyclaw/directory-picker-native
 */

export { pickNativeDirectory } from './native-picker.ts'
export type { DirectoryPickerInternals } from './native-picker.ts'
export { pickWin32Directory, DIALOG_TITLE } from './win32-dialog.ts'
export type { Win32DialogInternals, Win32DialogWorkerLike } from './win32-dialog.ts'
export type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'
