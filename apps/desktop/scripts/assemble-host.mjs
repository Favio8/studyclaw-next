#!/usr/bin/env node
/**
 * Assemble desktop sidecar resources.
 *   resources/host/bin.js          <- apps/cli/lib/bin.js (ESM bundle, prebuilt)
 *   resources/host/package.json    <- {"type":"module"}
 *   resources/host/node_modules    <- host-runtime install closure (koffi/pdf-parse)
 *   resources/web                  <- apps/web/out (next static export)
 *
 * Pass --build to also run the CLI bundle build and web export first.
 * 本机适配：corepack 已损坏、pnpm 不在 PATH——构建命令直接调用各包本地
 * 依赖入口（与 AGENTS_studyclaw-next.md 的「统一改用仓库根 node_modules 直调」
 * 约定一致），不再经由 pnpm --filter。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const repoRoot = resolve(desktop, '..', '..')
const resources = join(desktop, 'resources')
const hostOut = join(resources, 'host')
const webOut = join(resources, 'web')
const runtimePkg = join(desktop, 'host-runtime')

function run(cmd, args, cwd, label, opts = {}) {
  const env = { ...process.env }
  // 本机 npm 的默认 cache 指向 Program Files（不可写）——统一重定向到
  // 用户目录，除非调用方已显式指定。
  if (env.npm_config_cache === undefined) {
    env.npm_config_cache = join(env.HOME ?? env.USERPROFILE ?? '.', '.npm-cache')
  }
  // shell: true 时 Node 把 `cmd + ' ' + args.join(' ')` 直接交给 shell，**不自动
  // 加引号**——Node 装在 `C:\Program Files\nodejs` 这类带空格路径时（Windows
  // 默认安装位置！）可执行文件被劈成 `C:\Program`，报"不是内部或外部命令"，
  // 整个 `--build` 必败（CI runner 的 node 无空格，所以一直没暴露）。
  // 修法：自己拼好带引号的命令行，作为单一字符串交给 shell（保留 shell 是为了
  // Windows 上能跑 npm.cmd 这类 shim）。
  const quote = (value) => (/[\s&|<>^"]/.test(value) ? `"${value}"` : value)
  const command = [quote(cmd), ...args.map(quote)].join(' ')
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true, env })
  if (r.status !== 0) {
    // soft：安装器偶发的非致命退出码（如 pnpm 的 ignored-builds 警告）交由
    // 调用方做产物硬校验，脚本在此不直接失败。
    if (opts.soft === true) {
      console.warn(`[assemble] ${label ?? `${cmd} ${args.join(' ')}`} exited ${r.status} (soft failure, validating artifacts)`)
      return
    }
    throw new Error(`[assemble] ${label ?? `${cmd} ${args.join(' ')}`} failed (exit ${r.status}) [command: ${command}]`)
  }
}

/** 解析 pnpm 虚拟存储中的包真实入口（workspace 根 node_modules 无稳定 .js 入口）。 */
function pkgBinInPnpmStore(pkgName, binRel) {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm')
  const dir = readdirSync(pnpmDir).find(name => name.startsWith(`${pkgName}@`))
  if (dir === undefined) throw new Error(`[assemble] ${pkgName} not found under node_modules/.pnpm`)
  return join(pnpmDir, dir, 'node_modules', pkgName, binRel)
}

function mustExist(p, hint) {
  if (!existsSync(p)) throw new Error(`[assemble] missing ${p}. ${hint ?? ''}`)
}

function listFilesRecursive(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full))
    else out.push(full)
  }
  return out
}

const nodeBin = process.execPath

// 0) optional rebuild
if (process.argv.includes('--build')) {
  console.log('[assemble] building CLI bundle (tsc -b + tsdown)…')
  run(nodeBin, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.json'], join(repoRoot, 'apps', 'cli'), 'cli tsc -b')
  run(nodeBin, [pkgBinInPnpmStore('tsdown', 'dist/run.mjs')], join(repoRoot, 'apps', 'cli'), 'cli tsdown')
  console.log('[assemble] building web static export (next build)…')
  run(nodeBin, [pkgBinInPnpmStore('next', 'dist/bin/next'), 'build'], join(repoRoot, 'apps', 'web'), 'web next build')
}

// 1) clean output
rmSync(resources, { recursive: true, force: true })
mkdirSync(hostOut, { recursive: true })

// 2) host ESM bundle
const bundle = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
mustExist(bundle, 'Run the CLI bundle build first (node scripts/assemble-host.mjs --build).')
cpSync(bundle, join(hostOut, 'bin.js'))
// ESM marker: bin.js is ESM but keeps a .js extension; nearest package.json must declare type=module.
// bin.js 顶层还会 createRequire('../package.json') 读取版本号（bundle 内联），
// 因此 host/ 的上一级（resources/）也需要一份含 version 的 package.json。
const cliPkg = JSON.parse(readFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'))
writeFileSync(join(resources, 'package.json'), JSON.stringify({ name: 'studyclaw-host-resources', version: cliPkg.version, private: true }, null, 2) + '\n')
writeFileSync(join(hostOut, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n')

// 3) external runtime closure (koffi / pdf-parse + their platform native packages)
console.log('[assemble] installing host-runtime closure (resolves platform prebuilds)…')
// 用 npm --ignore-scripts 安装闭包：
// - koffi / @napi-rs/canvas 的原生 *.node 由平台分包（optionalDependencies
//   prebuild）随包分发，postinstall 全是冗余校验——跳过后运行时加载不受
//   影响（koffi require 已验证）。
// - pnpm 11 对跳过构建脚本会以 ERR_PNPM_IGNORED_BUILDS 整体退出 1，且失败
//   时机不稳定（偶发漏装 optional 平台包）；npm 平铺布局 + --ignore-scripts
//   退出码干净、闭包完整，且平铺后 pdf-parse → pdfjs-dist → canvas 的裸
//   import 全部可从顶层解析（pnpm 隔离布局则需 realpath 才能命中）。
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], runtimePkg, 'host-runtime install')
const runtimeModules = join(runtimePkg, 'node_modules')
mustExist(runtimeModules, 'host-runtime install did not produce node_modules')
mustExist(join(runtimeModules, 'koffi', 'package.json'), 'koffi missing from host-runtime closure')
mustExist(join(runtimeModules, 'pdf-parse', 'package.json'), 'pdf-parse missing from host-runtime closure')
mustExist(join(runtimeModules, 'pdfjs-dist', 'package.json'), 'pdfjs-dist missing from host-runtime closure (pdf-parse resolves it via bare import)')
mustExist(join(runtimeModules, '@napi-rs', 'canvas', 'package.json'), '@napi-rs/canvas missing from host-runtime closure (pdfjs-dist DOMMatrix polyfill on Node)')
const runtimeNatives = listFilesRecursive(runtimeModules).filter(f => f.endsWith('.node'))
if (runtimeNatives.length === 0) {
  throw new Error('[assemble] host-runtime closure has no *.node binaries — koffi / @napi-rs/canvas prebuilds missing.')
}
console.log(`[assemble] host-runtime closure OK (${runtimeNatives.length} native binaries)`)
// dereference: 把 symlink/junction 全部实体化拷贝，资源目录完全自包含
// （无指向 host-runtime 的悬空链接，electron-builder 收集也稳定）。
cpSync(runtimeModules, join(hostOut, 'node_modules'), { recursive: true, dereference: true })

// 4) web static export
const webDist = join(repoRoot, 'apps', 'web', 'out')
mustExist(webDist, 'Run web build first (node scripts/assemble-host.mjs --build).')
cpSync(webDist, webOut, { recursive: true })

// 5) fail loud when native artifacts for the current platform were not collected
const natives = listFilesRecursive(join(hostOut, 'node_modules')).filter(f => f.endsWith('.node'))
if (natives.length === 0) {
  throw new Error('[assemble] no *.node binary under host/node_modules — koffi / @napi-rs/canvas would fail at runtime.')
}
console.log(`[assemble] native binaries found: ${natives.length}`)
for (const n of natives) console.log('  ·', n.replace(hostOut, ''))
const totalBytes = listFilesRecursive(resources).reduce((s, f) => s + statSync(f).size, 0)
console.log(`[assemble] DONE → ${resources} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`)
