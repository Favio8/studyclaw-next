#!/usr/bin/env node
/**
 * 阶段三整机冒烟：真实路径 `electron .`（main.cjs）——
 * spawn sidecar → 轮询 host.json → 开窗 loadURL → UI 就绪。
 * 验证点：
 *   1. sidecar 进程拉起、host.json 写出（userData/host-home/）
 *   2. 窗口加载成功（console 无 net::ERR / fatal）
 *   3. 退出后 sidecar 无残留进程（R6）
 *
 * 用法：node scripts/smoke-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const repo = resolve(desktop, '..', '..')
const require = createRequire(import.meta.url)
const electron = process.env.ELECTRON_PATH ?? require('electron')

// 隔离的 userData：通过 main.cjs 的 STUDYCLAW_DESKTOP_USERDATA override
// 精确指定（A9），不再枚举猜测 Electron 的 app name 目录规则。
const userData = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'sc-desktop-ud-'))
console.log('[smoke] userData =', userData)

const child = spawn(electron, ['.'], {
  cwd: desktop,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', STUDYCLAW_DESKTOP_USERDATA: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})
let out = ''
child.stdout.on('data', d => { out += d })
child.stderr.on('data', d => { out += d })

const hostJsonPath = join(userData, 'host-home', 'host.json')

// 跨平台进程树终止与存活探测：taskkill/tasklist 是 Windows 专属命令，
// 非 Windows 平台用 kill/--kill 及 kill(pid, 0)。方案面向 win/mac/linux。
const killTree = pid => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
}
const pidAlive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}

const t0 = Date.now()
while (Date.now() - t0 < 20000) {
  if (existsSync(hostJsonPath)) break
  await new Promise(r => setTimeout(r, 250))
}
if (!existsSync(hostJsonPath)) {
  console.error('[smoke] FAIL: host.json not found in 20s\n', out.slice(-1500))
  killTree(child.pid)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
console.log('[smoke] host.json =', hostJsonPath)
console.log('[smoke] port =', cfg.port)

// 给窗口加载留出时间，然后检查渲染端日志中的致命错误。
await new Promise(r => setTimeout(r, 6000))
const fatalErrors = out.split('\n').filter(line =>
  /net::ERR_|Unable to load URL|Uncaught Exception|FATAL/.test(line),
)
console.log('[smoke] fatal renderer errors:', fatalErrors.length)
if (fatalErrors.length > 0) console.log(fatalErrors.slice(0, 5).join('\n'))

// UI 就绪探针：Host 侧 GET / 返回 200 即窗口 loadURL 同源可用。
const ui = await fetch(`http://127.0.0.1:${cfg.port}/`, { signal: AbortSignal.timeout(8000) })
const html = await ui.text()
console.log('[smoke] GET / via sidecar →', ui.status, 'token-injected:', html.includes('__STUDYCLAW__'))

// 退出：杀整棵树（模拟 window close → app.quit 路径之后的进程消失断言）。
killTree(child.pid)
await new Promise(r => setTimeout(r, 1500))
const residue = pidAlive(cfg.pid) ? 1 : 0
console.log('[smoke] sidecar residue after kill:', residue)
rmSync(userData, { recursive: true, force: true })

const pass = fatalErrors.length === 0 && ui.ok && html.includes('__STUDYCLAW__')
console.log(pass ? '[smoke] RESULT: PASS' : '[smoke] RESULT: FAIL')
process.exit(pass ? 0 : 1)
