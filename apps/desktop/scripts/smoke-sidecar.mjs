#!/usr/bin/env node
/**
 * 步骤 2.3 sidecar 独立冒烟（桌面方案「技术关口」的可重复验证）：
 *
 *   ELECTRON_RUN_AS_NODE=1 + 本机 electron.exe 作为纯 Node，
 *   拉起 resources/host/bin.js serve --port 0（免装 Node 链路）：
 *   1. 15s 内写出 host.json {pid, port, token, ...}
 *   2. GET /      → 200 且 index.html 已 tap 注入 window.__STUDYCLAW__
 *   3. GET /api/health → 200 {ok:true}
 *   4. GET /icon.svg   → 200（静态资源 MIME）
 *   5. 杀进程树后 host.json 被清理（残留锁检测）
 *
 * 用法：node scripts/smoke-sidecar.mjs [electronExePath]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const repo = resolve(desktop, '..', '..')
const require = createRequire(import.meta.url)

const electron = process.argv[2]
  ?? process.env.ELECTRON_PATH
  ?? require('electron')
const binJs = join(desktop, 'resources', 'host', 'bin.js')
const webDist = join(desktop, 'resources', 'web')
const home = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'sc-smoke-home-'))
const hostJson = join(home, 'host.json')

if (!existsSync(binJs)) {
  console.error('[smoke] missing resources/host/bin.js — run scripts/assemble-host.mjs first')
  process.exit(1)
}

console.log('[smoke] electron =', electron)
console.log('[smoke] home     =', home)
const child = spawn(electron, [binJs, 'serve', '--port', '0'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    STUDYCLAW_HOME: home,
    STUDYCLAW_WEB_DIST: webDist,
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let out = ''
child.stdout.on('data', d => { out += d })
child.stderr.on('data', d => { out += d })
child.on('exit', (code, signal) => { if (!quitting) console.error(`[smoke] sidecar exited early code=${code} signal=${signal}`) })
let quitting = false

const t0 = Date.now()
let cfg = null
while (Date.now() - t0 < 15000) {
  if (existsSync(hostJson)) { cfg = JSON.parse(readFileSync(hostJson, 'utf8')); break }
  if (child.exitCode !== null) break
  await new Promise(r => setTimeout(r, 200))
}
try {
  if (!cfg) throw new Error(`host.json not written in 15s\n${out.slice(-2000)}`)
  console.log('[smoke] host.json =', JSON.stringify({ ...cfg, token: cfg.token ? `<${String(cfg.token).length} chars>` : undefined }))

  const root = await fetch(`http://127.0.0.1:${cfg.port}/`)
  const html = await root.text()
  const injected = html.includes('__STUDYCLAW__')
  console.log('[smoke] GET /          →', root.status, 'token-injected:', injected)

  const health = await fetch(`http://127.0.0.1:${cfg.port}/api/health`)
  console.log('[smoke] GET /api/health →', health.status, JSON.stringify(await health.json()).slice(0, 80))

  const asset = await fetch(`http://127.0.0.1:${cfg.port}/icon.svg`)
  console.log('[smoke] GET /icon.svg   →', asset.status)

  const ok = root.ok && injected && health.ok && asset.ok

  quitting = true
  if (process.platform === 'win32') {
    // Windows 的 taskkill /F 是强杀——Host 的 SIGTERM 优雅清理（删 host.json
    // / 释放锁）不会执行。桌面方案的真实退出路径也如此（plan 4.3），因此
    // 关键验证不是「文件被删」而是「残留的 host.json/host.lock 能被下一次
    // 启动自愈」：二次启动必须能重新写 host.json 并正常服务。
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
  await new Promise(r => setTimeout(r, 1200))
  const staleHostJson = existsSync(hostJson)
  console.log('[smoke] stale host.json after force-kill (expected on win32 /F):', staleHostJson)

  // 二次启动自愈验证：同 home 重新拉起。
  const child2 = spawn(electron, [binJs, 'serve', '--port', '0'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      STUDYCLAW_HOME: home,
      STUDYCLAW_WEB_DIST: webDist,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const t1 = Date.now()
  let cfg2 = null
  while (Date.now() - t1 < 15000) {
    if (existsSync(hostJson)) {
      const c = JSON.parse(readFileSync(hostJson, 'utf8'))
      if (c.pid !== cfg.pid) { cfg2 = c; break }
    }
    if (child2.exitCode !== null) break
    await new Promise(r => setTimeout(r, 200))
  }
  let rehealthy = false
  if (cfg2) {
    const h2 = await fetch(`http://127.0.0.1:${cfg2.port}/api/health`)
    rehealthy = h2.ok
    console.log('[smoke] second launch → pid', cfg2.pid, 'port', cfg2.port, 'health:', h2.status)
  } else {
    console.error('[smoke] second launch failed to write a fresh host.json')
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child2.kill('SIGTERM')
  }
  await new Promise(r => setTimeout(r, 800))

  const pass = ok && cfg2 !== null && rehealthy
  console.log(pass ? '[smoke] RESULT: PASS' : '[smoke] RESULT: FAIL')
  if (!ok) console.log('[smoke] tail:', out.slice(-600))
  process.exit(pass ? 0 : 1)
} catch (error) {
  quitting = true
  console.error('[smoke] FAIL:', error instanceof Error ? error.message : error)
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  process.exit(1)
} finally {
  rmSync(home, { recursive: true, force: true })
}
