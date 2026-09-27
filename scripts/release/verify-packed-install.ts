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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestCliTarball } from './latest-tgz.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(repoRoot, 'artifacts')

function fail(message: string): never {
  console.error(`[release:verify] ✗ ${message}`)
  process.exit(1)
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
  const installedLib = readdirSync(join(installedDir, 'lib'))
  if (installedLib.some(name => name === 'types')) {
    fail('安装树泄漏了 lib/types/ 中间产物 —— files glob 配置错误')
  }

  // 3. 装完即跑：--help 与 status 必须可用（MODULE_NOT_FOUND 在此现形）。
  for (const args of [['--help'], ['status']]) {
    const run = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', timeout: 60_000 })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    if (run.status !== 0) fail(`\`studyclaw ${args.join(' ')}\` exit ${run.status}：\n${output.slice(0, 2000)}`)
    if (/ERR_MODULE_NOT_FOUND/.test(output)) fail(`\`studyclaw ${args.join(' ')}\` 缺模块：\n${output.slice(0, 2000)}`)
    console.log(`[release:verify] ✓ studyclaw ${args.join(' ')}`)
  }
  console.log(`[release:verify] ✓ ${latest} 装得上、跑得动`)
} finally {
  rmSync(installDir, { recursive: true, force: true })
}
