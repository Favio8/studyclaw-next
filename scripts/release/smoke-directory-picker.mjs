import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Same directory regardless of how the path is spelled (8.3 short name, junction, symlink). */
const sameDirectory = (a, b) => {
  try {
    const left = statSync(a, { bigint: true })
    const right = statSync(b, { bigint: true })
    return left.ino === right.ino && left.dev === right.dev
  } catch { return false }
}

/** Exercise real Win32 UI through an authenticated, built Host RPC. Only
 * automate windows owned by this fixture Host's child, never a user's dialog. */
export async function smokeDirectoryPicker({ base, token, hostPid, directory, requestPick = undefined }) {
  if (process.platform !== 'win32') return
  assert(Number.isInteger(hostPid) && hostPid > 0)
  // The picker returns the canonical path Windows hands back, and the workspace
  // registry stores `fs.realpath`. The fixture lives under `os.tmpdir()`, which on
  // a GitHub Windows runner is the 8.3 short name (RUNNER~1) and on macOS is a
  // symlink — so comparing against the unresolved input fails on those hosts.
  // Callers create the fixture before calling, so realpath is safe here.
  const canonicalDirectory = realpathSync(directory)
  // Automation uses the repository's tooling. Loading the fixture's native
  // DLL here pins its install directory until this verifier process exits.
  const koffi = createRequire(new URL('../../apps/cli/package.json', import.meta.url))('koffi')
  const user32 = koffi.load('user32.dll')
  const enumWindows = user32.func('__stdcall', 'EnumWindows', 'int', ['void *', 'intptr'])
  const enumChildren = user32.func('__stdcall', 'EnumChildWindows', 'int', ['void *', 'void *', 'intptr'])
  const getText = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int'])
  const getPid = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'void *'])
  const getId = user32.func('__stdcall', 'GetDlgCtrlID', 'int', ['void *'])
  const visible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *'])
  const sendText = user32.func('__stdcall', 'SendMessageW', 'intptr', ['void *', 'uint32', 'uintptr', 'void *'])
  const post = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const proto = koffi.proto('int __stdcall StudyClawSmokeEnum(void *hwnd, intptr lparam)')
  const enumerate = (enumerator, callback) => {
    const native = koffi.register(callback, koffi.pointer(proto))
    try { enumerator(native) } finally { koffi.unregister(native) }
  }
  const title = hwnd => {
    const buffer = Buffer.alloc(1024)
    getText(hwnd, buffer, 512)
    return buffer.toString('utf16le').split('\0')[0]
  }
  // A cold `Get-CimInstance Win32_Process` on a fresh Windows runner routinely
  // outlasts the 5s this used to allow — the warm cost on a developer machine is
  // already ~2s, so 5s was a race that only a warm machine won. The ownership
  // assertion itself is unchanged; only the transport budget and the diagnostics
  // are fixed, so a future failure states whether it timed out or WMI is unusable.
  const ownedPids = () => {
    const children = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}" | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (children.status !== 0) {
      throw new Error(
        `Cannot identify the fixture picker process: Get-CimInstance exited ${children.status}` +
        `${children.error ? ` (${children.error.code})` : ''}` +
        `${children.stderr ? ` — ${children.stderr.trim()}` : ''}`,
      )
    }
    return new Set(children.stdout.trim().split(/\s+/).filter(Boolean).map(Number))
  }
  // Each pick may spawn its own worker, so this is scoped to one `exercise` call:
  // reusing the set across picks would miss the new worker's pid, while recomputing
  // it on every poll of a failing lookup would re-spawn PowerShell six times.
  let owned = null
  const findDialog = () => {
    const candidates = []
    enumerate(cb => enumWindows(cb, 0), hwnd => {
      if (title(hwnd) === '选择 StudyClaw 工作区目录') {
        const pid = Buffer.alloc(4)
        getPid(hwnd, pid)
        candidates.push({ hwnd, pid: pid.readUInt32LE() })
      }
      return 1
    })
    if (candidates.length === 0) return null
    owned ??= ownedPids()
    return candidates.find(candidate => owned.has(candidate.pid))?.hwnd ?? null
  }
  const rpc = async (method, payload = {}) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }), signal: AbortSignal.timeout(20_000),
    })
    const envelope = await response.json()
    assert(envelope.ok, `Picker RPC failed: ${JSON.stringify(envelope)}`)
    return envelope.result
  }
  const exercise = async cancel => {
    owned = null
    const result = requestPick ? requestPick(cancel) : rpc('host.pickDirectory')
    // Observe early RPC failures without an unhandled rejection while looking
    // for the modal window. A missing worker must fail, not pass as cancellation.
    let failure
    result.catch(error => { failure = error })
    let dialog = null
    const deadline = Date.now() + 12_000
    while (dialog === null && Date.now() < deadline) {
      if (failure) throw failure
      dialog = findDialog()
      if (dialog === null) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(dialog, 'Built Host did not open a native folder dialog')
    try {
      if (cancel) {
        assert(post(dialog, 0x10, 0, 0), 'Could not cancel fixture dialog')
      } else {
        let edit = null
        let select = null
        enumerate(cb => enumChildren(dialog, cb, 0), hwnd => {
          if (visible(hwnd) && getId(hwnd) === 1152) edit = hwnd
          if (visible(hwnd) && getId(hwnd) === 1) select = hwnd
          return 1
        })
        assert(edit && select, 'Folder dialog is missing its path field or Select button')
        assert(sendText(edit, 0x0c, 0, Buffer.from(`${canonicalDirectory}\0`, 'utf16le')), 'Could not enter fixture path')
        assert(post(select, 0x00f5, 0, 0), 'Could not select fixture folder')
      }
      const picked = await result
      if (cancel) {
        assert.equal(picked.path, null)
      } else {
        // The shell returns the path in its own canonical form: on a GitHub Windows
        // runner that is the long name even though the fixture was typed as the 8.3
        // short one, and Node's `fs.realpath` does not expand 8.3 short names.
        // Comparing directory identity keeps this assertion about "it selected our
        // fixture" rather than about how either side happens to spell the path.
        assert(
          sameDirectory(picked.path, canonicalDirectory),
          `Picker returned ${picked.path}, expected the fixture ${canonicalDirectory}`,
        )
      }
    } finally {
      // If an assertion fails, close only this fixture's dialog.
      post(dialog, 0x10, 0, 0)
    }
  }
  await exercise(false)
  const opened = await rpc('workspaces.open', { path: canonicalDirectory })
  // Same spelling trap as the picker result: the Host canonicalizes through
  // Node's native realpath (GetFinalPathNameByHandle), which expands the 8.3
  // short name, while `fs.realpathSync`'s JS implementation does not. Compare
  // directory identity rather than the string.
  assert(
    sameDirectory(opened.workspace.path, canonicalDirectory),
    `workspaces.open returned ${opened.workspace.path}, expected ${canonicalDirectory}`,
  )
  const listed = await rpc('workspaces.courses', { path: canonicalDirectory })
  assert.equal(listed.missing, false)
  await exercise(true)
  assert.equal(findDialog(), null, 'Picker left an orphan dialog')
  console.log('[picker-smoke] PASS: native selection → project open → courses; cancel → null; no orphan dialog')
}
