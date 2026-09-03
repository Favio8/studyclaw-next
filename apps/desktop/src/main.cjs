// @ts-check
'use strict'
// StudyClaw 桌面壳主进程：生命周期 / 单实例 / sidecar 托管 / 窗口 / 菜单。
// 业务逻辑全部在 sidecar（Host bundle）里，壳只做进程胶水——见
// DESKTOP_SHELL_PLAN_studyclaw-next.md 第 4/7 节。
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

// 开发联调模式：设置 STUDYCLAW_DESKTOP_DEV_URL 后不拉起 sidecar，
// 直接加载外部地址（配合 `pnpm serve` / `next dev` 热更新，plan 3.4）。
const DEV_URL = process.env.STUDYCLAW_DESKTOP_DEV_URL || ''
const isDev = DEV_URL !== ''
// A9（第三轮审查）：冒烟/测试可精确指定 userData——必须在单实例锁之前
// 设置（锁文件位于 userData 下），且早于一切 getPath('userData') 消费者。
if (process.env.STUDYCLAW_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.STUDYCLAW_DESKTOP_USERDATA)
}
const START_TIMEOUT_MS = 15_000
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000]

/** @type {import('electron').BrowserWindow | null} */
let win = null
/** @type {import('node:child_process').ChildProcess | null} */
let host = null
let hostHome = ''
let hostJsonPath = ''
let restartIdx = 0
let quitting = false
/** 5 分钟窗口内的崩溃重启计数（plan 4.3：超过 3 次停止重试并弹错）。 */
let lastRestartWindow = []

function paths() {
  // userData 是各平台规范的应用数据目录；Host 的全部状态收在 host-home/
  // 子目录里（workspace 注册表、config、加密凭据、host.json、logs），
  // 不污染用户家目录的 ~/.studyclaw。
  hostHome = join(app.getPath('userData'), 'host-home')
  hostJsonPath = join(hostHome, 'host.json')
  // 打包态：process.resourcesPath 已是 <app>/resources（extraResources to:host
  // 直接落在其下）；开发态：main.cjs 在 src/ 下一层，resources 与 src 平级。
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
  const hostBundle = join(resourcesRoot, 'host', 'bin.js')
  const webDist = join(resourcesRoot, 'web')
  return { resourcesRoot, hostBundle, webDist }
}

function startHost() {
  if (isDev) return // dev：外部已运行的 serve 就是 Host
  const { hostBundle, webDist } = paths()
  if (!existsSync(hostBundle)) {
    fatal('缺少 Host 资源 resources/host/bin.js，请先运行 node scripts/assemble-host.mjs')
    return
  }
  if (!existsSync(hostHome)) mkdirSync(hostHome, { recursive: true })
  // ELECTRON_RUN_AS_NODE=1：让应用可执行文件本身充当纯 Node.js 运行时跑
  // Host bundle——壳不需要额外分发 Node 安装包（零额外运行时体积）。
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    STUDYCLAW_HOME: hostHome,
    STUDYCLAW_WEB_DIST: webDist,
    NODE_ENV: 'production',
  }
  host = spawn(process.execPath, [hostBundle, 'serve', '--port', '0'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout?.on('data', d => process.stdout.write(`[host] ${d}`))
  host.stderr?.on('data', d => process.stderr.write(`[host] ${d}`))
  host.on('exit', (code, signal) => {
    host = null
    if (quitting || isDev) return
    console.error(`[desktop] host exited code=${code} signal=${signal}`)
    const now = Date.now()
    lastRestartWindow = lastRestartWindow.filter(t => now - t < 300_000)
    if (lastRestartWindow.length >= 3) {
      fatal('本地服务多次启动失败，请查看日志：' + join(hostHome, 'logs'))
      return
    }
    lastRestartWindow.push(now)
    const wait = RESTART_BACKOFF_MS[Math.min(restartIdx++, RESTART_BACKOFF_MS.length - 1)]
    setTimeout(startHost, wait)
  })
}

function stopHost() {
  if (!host || host.pid === undefined) return
  const pid = host.pid
  try {
    if (process.platform === 'win32') {
      // /T 清整棵进程树（Electron-as-node 在部分路径下会派生辅助进程）。
      // 强杀不触发 Host 的 SIGTERM 优雅收尾（host.json/lock 残留），但
      // Host 启动时对过期 lock 自愈（冒烟已验证二次启动自愈）。
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      host.kill('SIGTERM') // Host 有 SIGTERM 优雅退出 handler
      const ref = host
      setTimeout(() => { try { ref.kill('SIGKILL') } catch {} }, 3_000)
    }
  } catch (e) {
    console.error('[desktop] stopHost error', e)
  }
  host = null
}

function readHostConfig() {
  try {
    const cfg = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
    if (Number.isInteger(cfg.port) && cfg.port > 0) return cfg
  } catch {}
  return null
}

function waitForHost() {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const cfg = readHostConfig()
      if (cfg) return resolve(cfg)
      if (Date.now() - t0 > START_TIMEOUT_MS) return reject(new Error('host-start-timeout'))
      setTimeout(tick, 150)
    }
    tick()
  })
}

async function createMainWindow() {
  let url
  if (isDev) {
    url = DEV_URL
  } else {
    const cfg = await waitForHost()
    url = `http://127.0.0.1:${cfg.port}/`
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#F4F3EE',
    title: 'StudyClaw',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  // 外链一律走系统浏览器，绝不在应用内开新窗。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    const allowed = isDev ? target.startsWith(DEV_URL) : /^http:\/\/127\.0\.0\.1:\d+\//.test(target)
    if (!allowed) { e.preventDefault(); shell.openExternal(target) }
  })
  await win.loadURL(url)
  win.on('closed', () => { win = null })
}

function fatal(message) {
  dialog.showErrorBox('StudyClaw 启动失败', message)
  app.quit()
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(paths().hostHome) },
        { label: '打开日志目录', click: () => shell.openPath(join(paths().hostHome, 'logs')) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 单实例：二次启动聚焦已有窗口（与 Host 的 host.lock 双保险，R8）。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() } else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    buildMenu()
    startHost()
    try {
      await createMainWindow()
    } catch (e) {
      fatal(`无法连接本地学习服务（${String(e && e.message || e)}）。数据目录：${hostHome}`)
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createMainWindow() })
  })

  app.on('before-quit', () => { quitting = true; stopHost() })
  app.on('window-all-closed', () => {
    quitting = true
    stopHost()
    if (process.platform !== 'darwin') app.quit()
  })
}

// contextIsolation 之后的诊断信息最小暴露面（供未来的桌面诊断 UI 使用）。
ipcMain.handle('studyclaw:host-info', () => (isDev ? { dev: true } : readHostConfig()))
