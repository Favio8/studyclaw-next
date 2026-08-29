/**
 * FL-21/30/35 宿主冒烟（打包形态）：起 serve（临时 STUDYCLAW_HOME），断言
 * ① /api/health 免 token 可达；② /api/* 无 token → 401；③ 带 host.json 的
 * token → 200；④ GET / 返回注入了 __STUDYCLAW__ 的 index.html；⑤ CLI 从
 * host.json 自动发现端口+token 后 `status` 可用。结束清理临时目录与进程。
 * 用法：node_modules/.bin/tsx --tsconfig tsconfig.base.json scripts/release/smoke-serve.ts
 * @module scripts/release/smoke-serve
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const binPath = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(binPath)) {
  console.error('[smoke-serve] ✗ 未找到 apps/cli/lib/bin.js：请先 pnpm run release:pack')
  process.exit(1)
}
if (!existsSync(join(repoRoot, 'apps', 'web', 'out', 'index.html'))) {
  console.error('[smoke-serve] ✗ 未找到 apps/web/out/index.html：请先 pnpm run release:pack')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'studyclaw-smoke-'))
const port = 18117
const child = spawn(process.execPath, [binPath, 'serve', '--port', String(port)], {
  env: { ...process.env, STUDYCLAW_HOME: home },
  stdio: 'ignore',
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init)
}

function fail(message: string): never {
  console.error(`[smoke-serve] ✗ ${message}`)
  child.kill()
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

try {
  // 等 host.json 出现（listen 完成信号），最长 15s。
  const hostJsonPath = join(home, 'host.json')
  let hostJson: { port?: number; token?: string | null } | null = null
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(hostJsonPath)) {
      hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf8'))
      break
    }
    await sleep(100)
  }
  if (hostJson === null || typeof hostJson.token !== 'string') {
    fail('host.json 未生成或缺少 token')
  }
  const token = hostJson.token as string

  // ① health 免 token
  const health = await fetchJson('/api/health')
  if (!health.ok) fail(`health 状态 ${health.status}`)
  console.log('[smoke-serve] ✓ /api/health 免 token 可达')

  // ② /api/* 无 token → 401
  const noAuth = await fetchJson('/api/workspaces.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (noAuth.status !== 401) fail(`无 token 期望 401，实际 ${noAuth.status}`)
  console.log('[smoke-serve] ✓ 无 token 调 RPC 被拒（401）')

  // ③ 带 token → 200
  const withAuth = await fetchJson('/api/workspaces.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  })
  if (withAuth.status !== 200) fail(`带 token 期望 200，实际 ${withAuth.status}`)
  console.log('[smoke-serve] ✓ Bearer token 调 RPC 可达')

  // ④ 静态 UI + tap 注入
  const page = await fetchJson('/')
  const html = await page.text()
  if (!page.ok || !html.includes('window.__STUDYCLAW__') || !html.includes(token)) {
    fail('index.html 未注入 __STUDYCLAW__ token tap')
  }
  console.log('[smoke-serve] ✓ 同源 Web UI 托管 + token tap 注入')

  // ⑤ CLI 自动发现端口+token
  const status = spawnSync(process.execPath, [binPath, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, STUDYCLAW_HOME: home },
    timeout: 60_000,
  })
  if (status.status !== 0) fail(`CLI status 失败：\n${status.stdout}\n${status.stderr}`)
  console.log('[smoke-serve] ✓ CLI 从 host.json 自动发现端口+token（status 退出码 0）')

  console.log('[smoke-serve] ✓ 全部通过')
} finally {
  child.kill()
  await sleep(300)
  rmSync(home, { recursive: true, force: true })
}
