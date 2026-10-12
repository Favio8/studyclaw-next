/**
 * FL-43：打包安装验证（dsh `release:verify-packed-install` 同职）——把打好的
 * tgz 真的装一遍并运行。FL-20（files glob 覆盖不到产物）之所以潜伏至今，
 * 正是因为从来没人装过打好的包；本脚本是这类缺陷的永久门禁。
 *
 * 步骤：定位 artifacts/ 下最新的 @studyclaw/cli tgz → 临时目录 `npm install`
 * → 断言 tarball/安装树结构（lib/bin.js 存在、无 lib/types 泄漏）→ 运行
 * `--help` 与 `status`，断言 exit 0 且输出可读。
 *
 * @module scripts/release/verify-packed-install
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestCliTarball } from './latest-tgz.ts'
import { assertHostArtifacts } from './bundle-contract.mjs'
import { smokeDirectoryPicker } from './smoke-directory-picker.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(repoRoot, 'artifacts')
type InstalledHostConfig = { port: number; token: string; pid: number }

function fail(message: string): never {
  throw new Error(`[release:verify] ✗ ${message}`)
}

/** Exercise the lazy upload path; --help/status alone cannot detect missing Busboy chunks. */
async function smokeInstalledUpload(binPath: string, installDir: string): Promise<void> {
  const home = join(installDir, 'fixture-home')
  const course = join(installDir, 'fixture-course')
  mkdirSync(join(course, '.studyclaw'), { recursive: true })
  writeFileSync(join(course, '.studyclaw', 'config.yaml'), "llm:\n  provider: ''\n  model: ''\n  api_base: http://127.0.0.1:1\nparse:\n  engine: builtin\n")
  const env: NodeJS.ProcessEnv = { ...process.env, STUDYCLAW_HOME: home }
  delete env.STUDYCLAW_HOST_URL
  // This offline fixture must not inherit real model or service credentials.
  for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key]
  const child = spawn(process.execPath, [binPath, 'serve', '--port', '0'], {
    env, windowsHide: true, stdio: 'ignore',
  })
  let spawnError: Error | null = null
  child.on('error', error => { spawnError = error })
  try {
    const deadline = Date.now() + 20_000
    const configPath = join(home, 'host.json')
    let config: InstalledHostConfig | null = null
    while (Date.now() < deadline) {
      if (spawnError !== null) throw spawnError
      if (child.exitCode !== null) throw new Error('installed Host exited during startup')
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as InstalledHostConfig
        if (parsed.pid === child.pid && Number.isInteger(parsed.port) && parsed.port > 0
          && parsed.port <= 65535 && typeof parsed.token === 'string') config = parsed
      } catch { /* file not ready */ }
      if (config !== null) break
      await new Promise(yes => setTimeout(yes, 50))
    }
    if (config === null) throw new Error('installed Host did not become ready')
    const base = `http://127.0.0.1:${config.port}`
    const headers = { Authorization: `Bearer ${config.token}` }
    const pickerFixture = join(installDir, "内测 一📚 O'Brien 资料")
    mkdirSync(pickerFixture)
    await smokeDirectoryPicker({ base, token: config.token, hostPid: config.pid, directory: pickerFixture })
    const opened = await fetch(`${base}/api/workspaces.open`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { path: course } }), signal: AbortSignal.timeout(10_000),
    })
    const envelope = await opened.json() as { ok: boolean }
    if (!opened.ok || !envelope.ok) throw new Error('installed Host could not open the fixture project')
    const form = new FormData()
    form.append('files', new Blob(['# Fixture\n\n## Concept\n\nOffline upload check.']), 'fixture.md')
    const response = await fetch(`${base}/api/courses/fixture-course/sources`, {
      method: 'POST', headers, body: form, signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok || !existsSync(join(course, 'sources', 'fixture.md'))) throw new Error('installed multipart upload failed (missing lazy bundle dependency?)')
    console.log('[release:verify] ✓ installed Host multipart upload')
    // Exercise the installed CLI, client, binary HTTP routes, ZIP and registry together.
    writeFileSync(join(course, '.studyclaw', 'notes.md'), 'PACKED-TRANSFER-CANARY\n')
    const archive = join(installDir, 'course.studyclaw.zip')
    const runTransfer = (args: string[]): void => {
      const run = spawnSync(process.execPath, [binPath, ...args], {
        cwd: installDir, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      if (run.status !== 0) throw new Error(`installed CLI ${args[0]} failed: ${run.stderr || run.error?.message}`)
    }
    runTransfer(['export', '--course', 'fixture-course', '--format', 'backup', '--out', archive])
    const target = join(installDir, 'restore-root')
    mkdirSync(target)
    const activate = async (path: string): Promise<void> => {
      const response = await fetch(`${base}/api/workspaces.open`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { path } }), signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('installed restored project could not open')
    }
    await activate(target)
    runTransfer(['import', archive, '--course-id', 'restored'])
    const restored = join(target, 'restored')
    if (readFileSync(join(restored, '.studyclaw', 'notes.md'), 'utf8') !== 'PACKED-TRANSFER-CANARY\n') throw new Error('installed restore lost notes')
    const treeResponse = await fetch(`${base}/api/workspaces.list`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: {} }), signal: AbortSignal.timeout(10_000),
    })
    const tree = await treeResponse.json() as { result?: { items: Array<{ path: string }> } }
    if (!tree.result?.items.some(item => item.path === restored)) throw new Error('installed restore was not registered')
    await activate(restored)
    const markdown = join(installDir, 'restored.md')
    runTransfer(['export', '--course', 'restored', '--out', markdown])
    if (!readFileSync(markdown, 'utf8').includes('PACKED-TRANSFER-CANARY')) throw new Error('installed restored course is not usable')
    console.log('[release:verify] ✓ installed CLI backup/import/register/open/Markdown round trip')
  } finally {
    child.kill()
    const deadline = Date.now() + 7_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(yes => setTimeout(yes, 50))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

const tarball = latestCliTarball(outDir)
if (tarball === null) {
  fail('artifacts/ 下没有 studyclaw-cli-*.tgz：请先运行 pnpm run release:pack')
}
const latest = tarball.name
console.log(`[release:verify] 验证 ${latest}`)
const tarballPath = tarball.path

// 1. tarball 结构断言交给安装树（跨平台无 tar 依赖）：装完后 bin 入口必须
//    存在、lib/types 中间产物不得泄漏（files glob 配置错误在此现形）。

// 2. 真装一遍（隔离临时目录，纯 npm 语义，无 workspace 魔法）。
const installDir = mkdtempSync(join(tmpdir(), 'studyclaw-packed-'))
try {
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--cache', join(repoRoot, 'artifacts', '.npm-cache'), tarballPath], {
    cwd: installDir, encoding: 'utf8', shell: process.platform === 'win32',
  })
  if (install.status !== 0) fail(`npm install 失败：\n${install.stdout}\n${install.stderr}`)
  const installedDir = join(installDir, 'node_modules', '@studyclaw', 'cli')
  const binPath = join(installedDir, 'lib', 'bin.js')
  if (!existsSync(binPath)) fail('安装树里没有 node_modules/@studyclaw/cli/lib/bin.js')
  assertHostArtifacts(join(installedDir, 'lib'))
  if (!existsSync(join(installedDir, 'THIRD_PARTY_NOTICES.md'))) fail('安装树缺少 THIRD_PARTY_NOTICES.md')
  const installedLib = readdirSync(join(installedDir, 'lib'))
  if (installedLib.some(name => name === 'types')) {
    fail('安装树泄漏了 lib/types/ 中间产物 —— files glob 配置错误')
  }

  // 3. 装完即跑：--help 与 status 必须可用（MODULE_NOT_FOUND 在此现形）。
  for (const args of [['--help'], ['status']]) {
    const run = spawnSync(process.execPath, [binPath, ...args], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, STUDYCLAW_HOME: join(installDir, 'fixture-home') },
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    if (run.status !== 0) fail(`\`studyclaw ${args.join(' ')}\` exit ${run.status}：\n${output.slice(0, 2000)}`)
    if (/ERR_MODULE_NOT_FOUND/.test(output)) fail(`\`studyclaw ${args.join(' ')}\` 缺模块：\n${output.slice(0, 2000)}`)
    console.log(`[release:verify] ✓ studyclaw ${args.join(' ')}`)
  }
  await smokeInstalledUpload(binPath, installDir)
  console.log(`[release:verify] ✓ ${latest} 装得上、跑得动`)
} finally {
  rmSync(installDir, { recursive: true, force: true })
}
