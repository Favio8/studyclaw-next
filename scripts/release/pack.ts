/**
 * FL-43：发布打包（dsh `scripts/release/pack.ts` 同职）。
 *
 * 1. 构建 CLI 自包含 bundle（tsc -b + tsdown → apps/cli/lib/bin.js）与
 *    Web 静态导出（next build → apps/web/out，由 serve 托管）；
 * 2. 合成发布清单——已打包形态下 @studyclaw/* / @deepseek-ai/* 闭包已进
 *    bundle，清单只声明真正的 npm 外部依赖（koffi / pdf-parse）；
 * 3. 在 staging 目录里 `npm pack`，产物落入 artifacts/。
 *
 * @module scripts/release/pack
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cliDir = join(repoRoot, 'apps', 'cli')
const stageDir = join(repoRoot, 'artifacts', 'stage')
const outDir = join(repoRoot, 'artifacts')

function run(command: string, args: string[], cwd: string, opts: { shell?: boolean } = {}): void {
  // node 直调一律关 shell：本机 node 安装在带空格路径（D:\Program Files\...），
  // shell 模式会把 command 从空格处截断。仅 npm（.cmd shim）保留 shell。
  const shell = opts.shell ?? (process.platform === 'win32' && command === 'npm')
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${result.status}）`)
  }
}

/**
 * 解析 pnpm 虚拟存储中的包真实入口（workspace 根 node_modules 无稳定 .js 入口）。
 * 本机 corepack 已坏、CI 由 action-setup 提供 pnpm——为让本机与 CI 走同一条
 * 路径，构建命令一律 node 直调包入口（与 apps/desktop/scripts/assemble-host.mjs
 * 的适配一致），不再经由 pnpm --filter。
 */
function pkgBinInPnpmStore(pkgName: string, binRel: string): string {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm')
  const dir = readdirSync(pnpmDir).find(name => name.startsWith(`${pkgName}@`))
  if (dir === undefined) throw new Error(`[release:pack] ${pkgName} not found under node_modules/.pnpm`)
  return join(pnpmDir, dir, 'node_modules', pkgName, binRel)
}

const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
  description: string
  license: string
  type: string
  bin: Record<string, string>
  files: string[]
  engines: { node: string }
  dependencies: Record<string, string>
}

// CLI 自包含 bundle：tsc -b（project references）→ tsdown 打平为 lib/bin.js。
run(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.json'], cliDir)
run(process.execPath, [pkgBinInPnpmStore('tsdown', 'dist/run.mjs')], cliDir)
// Web 静态导出（next build，output: 'export' → apps/web/out）。serve 会托管
// 该目录；npm 包本身不含它（体积考量），但发布流程要确认导出通路可用。
run(process.execPath, [pkgBinInPnpmStore('next', 'dist/bin/next'), 'build'], join(repoRoot, 'apps', 'web'))

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(join(stageDir, 'lib'), { recursive: true })
cpSync(join(cliDir, 'lib', 'bin.js'), join(stageDir, 'lib', 'bin.js'))
for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(join(repoRoot, name), join(stageDir, name))
}

/** FL-20：发布清单只保留 npm 可解析的外部依赖；workspace 闭包已全部入包。 */
const publishManifest = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  license: manifest.license,
  type: manifest.type,
  bin: manifest.bin,
  files: manifest.files,
  // 单一事实源：engines 与根/apps/cli 清单一致（Node 20 已 EOL，不再承诺支持）。
  engines: manifest.engines,
  dependencies: {
    koffi: manifest.dependencies['koffi'] ?? '^3.1.0',
    'pdf-parse': manifest.dependencies['pdf-parse'] ?? '^2.4.5',
  },
}
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`, 'utf8')

mkdirSync(outDir, { recursive: true })
// npm 缓存指向仓库本地产物目录：默认缓存可能落在无写权限的安装目录
//（本机实测 npm cache 指向 D:\Program Files\nodejs 时 EPERM）。
run('npm', ['pack', '--pack-destination', outDir, '--cache', join(repoRoot, 'artifacts', '.npm-cache')], stageDir)

console.log(`[release:pack] 打包完成 → ${outDir}`)
console.log('[release:pack] 下一步：pnpm run release:verify')
