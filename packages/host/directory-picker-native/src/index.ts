/**
 * Native OS directory picker for the StudyClaw host — tiered like dsh's
 * `directory-picker-native` (MIT): Windows opens the modern `IFileOpenDialog`
 * in a spawned child process (a koffi-driven COM conversation on the child's
 * main thread) so the dialog is the process's first window and Windows
 * activates it without a manual foreground call; macOS uses `osascript choose
 * folder`; Linux uses `zenity` with a `kdialog` fallback (FL-45). Tiers that
 * cannot run throw "unavailable" and the caller composes the browse backend.
 * @module @studyclaw/directory-picker-native
 */

export { pickNativeDirectory } from './native-picker.ts'
export type { DirectoryPickerInternals } from './native-picker.ts'
export { runNativeCommand } from './native-command.ts'
export type { NativeCommandRunner } from './native-command.ts'
export { pickWin32Directory, DIALOG_TITLE } from './win32-dialog.ts'
export type { Win32DialogInternals, Win32DialogWorkerLike } from './win32-dialog.ts'
export type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'
