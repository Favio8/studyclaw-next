import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** Exercise real Win32 UI through an authenticated, built Host RPC. Only
 * automate windows owned by this fixture Host's child, never a user's dialog. */
export async function smokeDirectoryPicker({ base, token, hostPid, directory, requestPick = undefined }) {
  if (process.platform !== 'win32') return
  assert(Number.isInteger(hostPid) && hostPid > 0)
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
    const children = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}" | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (children.status !== 0) throw new Error('Cannot identify the fixture picker process')
    const ownedPids = new Set(children.stdout.trim().split(/\s+/).map(Number))
    return candidates.find(candidate => ownedPids.has(candidate.pid))?.hwnd ?? null
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
        assert(sendText(edit, 0x0c, 0, Buffer.from(`${directory}\0`, 'utf16le')), 'Could not enter fixture path')
        assert(post(select, 0x00f5, 0, 0), 'Could not select fixture folder')
      }
      assert.deepEqual(await result, { path: cancel ? null : directory })
    } finally {
      // If an assertion fails, close only this fixture's dialog.
      post(dialog, 0x10, 0, 0)
    }
  }
  await exercise(false)
  const opened = await rpc('workspaces.open', { path: directory })
  assert.equal(opened.workspace.path, directory)
  const listed = await rpc('workspaces.courses', { path: directory })
  assert.equal(listed.missing, false)
  await exercise(true)
  assert.equal(findDialog(), null, 'Picker left an orphan dialog')
  console.log('[picker-smoke] PASS: native selection → project open → courses; cancel → null; no orphan dialog')
}
