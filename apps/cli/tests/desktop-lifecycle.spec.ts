import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const mainPath = fileURLToPath(new URL('../../desktop/src/main.cjs', import.meta.url))
const source = await readFile(mainPath, 'utf8')
// main.cjs 的主窗口加载辅助（真实模块）：vm 沙箱里按路径注入，测试覆盖真实逻辑。
const { loadWindowUrl } = createRequire(import.meta.url)('../../desktop/src/window-load.cjs') as {
  loadWindowUrl: (win: unknown, url: string, state?: unknown) => Promise<{ ok: boolean; error?: unknown }>
}

function harness(devUrl = '') {
  const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter }> = []
  const timers: Array<() => void> = []
  let now = 0
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
    children.push(child)
    return child
  })
  const shell = { openPath: vi.fn(), openExternal: vi.fn() }
  const app = Object.assign(new EventEmitter(), { getPath: () => path.join(path.dirname(mainPath), 'fixture-user'), requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), quit: vi.fn(), isPackaged: false })
  const Menu = { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((items) => items) }
  const dialog = { showErrorBox: vi.fn() }
  class Window extends EventEmitter {
    static getAllWindows() { return [] }
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    loadURL = vi.fn(async () => {})
    isDestroyed = vi.fn(() => false)
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
  }
  const electron = { app, shell, Menu, dialog, BrowserWindow: Window, ipcMain: { handle: vi.fn() } }
  const fileSystem = { existsSync: () => true, mkdirSync: vi.fn(), rmSync: vi.fn(), readFileSync: () => JSON.stringify({ port: 8080, pid: 99 }) }
  const module = { exports: {} as {
    paths: () => { hostHome: string }; startHost: () => void; stopHost: () => void;
    buildMenu: () => void; createMainWindow: () => Promise<void>; waitForHost: () => Promise<unknown>;
    host: unknown; win: Window;
  } }
  vm.runInNewContext(source + '\nmodule.exports = { paths, startHost, stopHost, buildMenu, createMainWindow, waitForHost, get host() { return host }, get win() { return win } };', {
    module, __dirname: path.dirname(mainPath), console: { error: vi.fn() }, URL,
    Date: { now: () => now }, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length }, clearTimeout: vi.fn(),
    process: { env: { STUDYCLAW_DESKTOP_DEV_URL: devUrl }, platform: 'darwin', execPath: 'fixture-electron', on: vi.fn(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
    require: (name: string) => {
      if (name === 'electron') return electron
      if (name === 'node:child_process') return { spawn }
      if (name === 'node:fs') return fileSystem
      if (name === 'node:path') return path
      if (name === './window-load.cjs') return { loadWindowUrl }
      throw new Error(`unexpected require ${name}`)
    },
  })
  return { entry: module.exports, children, spawn, shell, app, dialog, Menu, timers, setTime: (value: number) => { now = value } }
}

describe('桌面主进程生命周期与导航边界', () => {
  it('再次启动显示隐藏的已有窗口，并恢复最小化窗口后聚焦', async () => {
    const h = harness('http://localhost:8080')
    await h.entry.createMainWindow()
    h.app.emit('second-instance')
    expect(h.entry.win.show).toHaveBeenCalledOnce()
    expect(h.entry.win.focus).toHaveBeenCalledOnce()
    expect(h.entry.win.restore).not.toHaveBeenCalled()
    h.entry.win.isMinimized.mockReturnValue(true)
    h.app.emit('second-instance')
    expect(h.entry.win.restore).toHaveBeenCalledOnce()
    expect(h.entry.win.show).toHaveBeenCalledTimes(2)
    expect(h.entry.win.focus).toHaveBeenCalledTimes(2)
  })
  it('合法内部导航正常放行，https 外链仍走系统浏览器', async () => {
    const h = harness('http://localhost:8080')
    await h.entry.createMainWindow()
    const preventDefault = vi.fn()
    h.entry.win.webContents.emit('will-navigate', { preventDefault }, 'http://localhost:8080/page')
    expect(preventDefault).not.toHaveBeenCalled()
    h.entry.win.webContents.emit('will-navigate', { preventDefault }, 'https://example.invalid/help')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(h.shell.openExternal).toHaveBeenCalledWith('https://example.invalid/help')
  })

  it('帮助菜单使用真实数据目录，不能传 undefined 给 shell', () => {
    const h = harness()
    h.entry.buildMenu()
    const items = h.Menu.buildFromTemplate.mock.calls[0]![0]
    const help = items.find((item: { label?: string }) => item.label === '帮助')
    help.submenu[0].click()
    expect(h.shell.openPath).toHaveBeenCalledWith(path.join(path.dirname(mainPath), 'fixture-user', 'host-home'))
  })

  it('旧 sidecar 退出不能清掉重新激活后的新 sidecar', () => {
    const h = harness()
    h.entry.startHost()
    h.entry.stopHost()
    h.entry.startHost()
    h.children[0]!.emit('exit', 0, 'SIGTERM')
    expect(h.entry.host).toBe(h.children[1])
  })

  it('sidecar 无法 spawn 时显示错误并走退出路径', () => {
    const h = harness()
    h.entry.startHost()
    expect(() => h.children[0]!.emit('error', new Error('fixture spawn failure'))).not.toThrow()
    expect(h.dialog.showErrorBox).toHaveBeenCalled()
    expect(h.app.quit).toHaveBeenCalled()
  })

  it('没有运行中的 sidecar 时不使用残留 host.json 握手', async () => {
    const h = harness()
    const pending = h.entry.waitForHost()
    h.setTime(16_000)
    h.timers.at(-1)?.()
    await expect(pending).rejects.toThrow('host-start-timeout')
  })

  it('页内导航拒绝非 http(s) 外链，不交给系统协议处理器', async () => {
    const h = harness('http://localhost:8080')
    await h.entry.createMainWindow()
    const preventDefault = vi.fn()
    h.entry.win.webContents.emit('will-navigate', { preventDefault }, 'file:///fixture/private.pdf')
    expect(preventDefault).toHaveBeenCalled()
    expect(h.shell.openExternal).not.toHaveBeenCalled()
  })

  it('开发联调地址按 origin 比较，不能放行伪造前缀主机名', async () => {
    const h = harness('http://localhost:8080')
    await h.entry.createMainWindow()
    const preventDefault = vi.fn()
    h.entry.win.webContents.emit('will-navigate', { preventDefault }, 'http://localhost:8080.evil.invalid/path')
    expect(preventDefault).toHaveBeenCalled()
  })
});
