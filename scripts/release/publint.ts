/**
 * FL-43：publint 门禁——对 artifacts/ 下最新的 @studyclaw/cli tgz 做包结构
 * 合法性校验（bin shebang、exports/files 一致性等）。tgz 直喂以规避
 * @publint/pack 的包管理器探测（stage 目录会被 packageManager 字段带到
 * 仓库根的 pnpm，而 shell PATH 上没有 pnpm）。
 * @module scripts/release/publint
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestCliTarball } from './latest-tgz.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(repoRoot, 'artifacts')
const tarball = latestCliTarball(outDir)
if (tarball === null) {
  console.error('[release:publint] ✗ artifacts/ 下没有 studyclaw-cli-*.tgz：请先运行 pnpm run release:pack')
  process.exit(1)
}
const tgz = tarball.path
const publintBin = join(repoRoot, 'node_modules', '.bin', 'publint')
const result = spawnSync(publintBin, [tgz, '--profile=node'], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(result.status ?? 1)
