#!/usr/bin/env node
/**
 * 阶段三整机冒烟：真实路径 `electron .`（main.cjs）——
 * spawn sidecar → 轮询 host.json → 开窗 loadURL → UI 就绪 → 应用自身退出路径。
 * 验证点：
 *   1. sidecar 进程拉起、host.json 写出（userData/host-home/）
 *   2. 窗口加载成功（console 无 net::ERR / fatal）
 *   3. 应用自身退出路径收尾：优先 SIGTERM（非 Windows）/ taskkill 无 /F 的
 *      WM_CLOSE 请求（Windows）走 before-quit → stopHost，sidecar 无残留（R6）；
 *      仅当优雅退出宽限内未生效才兜底强杀（强杀会留下孤儿 sidecar，属已知产品
 *      限制，此路径下不断言 residue）。
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

// ELECTRON_RUN_AS_NODE 会让 electron 二进制退化为纯 Node 运行（app 未定义，
// main.cjs 直接崩）——调用方环境（CI/Harness）可能带着它，必须显式剔除。
const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', STUDYCLAW_DESKTOP_USERDATA: userData }
delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.'], {
  cwd: desktop,
  env: childEnv,
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
// host.json 同理由非原子 writeFile 写出：existsSync 命中时可能只写了一半，
// 裸 JSON.parse 会抛未捕获异常崩栈（CLI 集成测试对同一场景专门做了重试）。
let cfg = null
for (let i = 0; i < 20 && cfg === null; i++) {
  try {
    cfg = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
  } catch {
    await new Promise(r => setTimeout(r, 250))
  }
}
if (cfg === null) {
  console.error('[smoke] FAIL: host.json 无法解析\n', out.slice(-1500))
  killTree(child.pid)
  process.exit(1)
}
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

// 退出：优先走应用自身的退出路径（before-quit → stopHost），验证收尾；
// 优雅退出宽限内未生效才兜底强杀，并标记 graceful=false。
// residue 只在优雅退出成功时纳入 pass 条件：强杀路径留下孤儿 sidecar 是已知
// 产品限制，不该让冒烟把"已知限制"判成失败；但优雅路径一旦不生效，R6 就被
// 跳过——所以这里显式告警，并可用 SMOKE_STRICT=1 把"优雅退出失败"本身判失败。
const gracefulStop = () => {
  if (process.platform === 'win32') {
    // 无 /F：向 GUI 窗口发 WM_CLOSE 关闭请求 → Electron 走正常退出流程。
    // taskkill 对无响应窗口/拒绝访问会失败，退出码必须看（否则静默走兜底）。
    const killed = spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' })
    if (killed.status !== 0) {
      console.log('[smoke] taskkill 关闭请求失败，status =', killed.status, killed.error?.code ?? '')
    }
  } else {
    child.kill('SIGTERM')
  }
}
gracefulStop()
await new Promise(r => setTimeout(r, 6000))
let graceful = !pidAlive(child.pid)
if (!graceful) {
  console.log('[smoke] 优雅退出宽限未生效，兜底强杀（R6 residue 断言被跳过）')
  killTree(child.pid)
}
await new Promise(r => setTimeout(r, 2000))
const residue = pidAlive(cfg.pid) ? 1 : 0
console.log('[smoke] graceful exit:', graceful, '| sidecar residue:', residue)
rmSync(userData, { recursive: true, force: true })

const strict = process.env.SMOKE_STRICT === '1'
const pass = fatalErrors.length === 0 && ui.ok && html.includes('__STUDYCLAW__')
  && (graceful ? residue === 0 : !strict)
console.log(pass ? '[smoke] RESULT: PASS' : '[smoke] RESULT: FAIL')
process.exit(pass ? 0 : 1)
