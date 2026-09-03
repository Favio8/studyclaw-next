'use strict'
/**
 * electron-builder afterPack 钩子：把 Host 的外置依赖闭包（koffi /
 * pdf-parse / pdfjs-dist / @napi-rs/canvas 平台原生包）落进安装产物的
 * resources/host/node_modules。
 *
 * 为什么不直接用 extraResources：app-builder-lib 的 createFilter 对相对
 * 路径恰为 node_modules 的顶层目录硬编码 return false（注释 "filter the
 * root node_modules"），任何 filter pattern 都无法让它重新包含——目录被
 * 剪枝后整棵闭包丢失。afterPack 在文件复制完成后执行，直接 fs.cpSync
 * 绕过 matcher，是官方支持的注入点。
 */
const { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

function listFilesRecursive(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full))
    else out.push(full)
  }
  return out
}

/** @type {import('app-builder-lib').AfterPackContext} */
module.exports = async function afterPack(context) {
  const desktopDir = context.packager.projectDir
  const srcNodeModules = resolve(desktopDir, 'resources', 'host', 'node_modules')
  const destHost = join(context.appOutDir, 'resources', 'host')
  const destNodeModules = join(destHost, 'node_modules')

  if (!existsSync(srcNodeModules)) {
    throw new Error(`[after-pack] missing ${srcNodeModules} — run scripts/assemble-host.mjs first`)
  }
  // A10：force:true 已覆盖目标存在与否两种情况，无需分支。
  cpSync(srcNodeModules, destNodeModules, { recursive: true, force: true, dereference: true })

  // 原生二进制硬校验（与 assemble 同标准）：装出来的包缺 .node 就直接失败，
  // 防止"打包成功但目录选择器/PDF 解析一跑即崩"的静默问题（R4/R5）。
  const natives = listFilesRecursive(destNodeModules).filter(f => f.endsWith('.node'))
  if (natives.length === 0) {
    throw new Error('[after-pack] no *.node binary under packaged host/node_modules')
  }
  // bin.js 顶层 createRequire('../package.json') 读版本号——resources 层
  // 需要一份 package.json（extraResources 只拷 host/、web/ 子目录）。
  const cliPkg = JSON.parse(readFileSync(resolve(desktopDir, '..', 'cli', 'package.json'), 'utf8'))
  writeFileSync(join(context.appOutDir, 'resources', 'package.json'), JSON.stringify({ name: 'studyclaw-host-resources', version: cliPkg.version, private: true }, null, 2) + '\n')
  const totalBytes = listFilesRecursive(destNodeModules).reduce((s, f) => s + statSync(f).size, 0)
  console.log(`[after-pack] host closure → ${destNodeModules} (${natives.length} native binaries, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`)
  for (const n of natives) console.log('  ·', n.replace(destNodeModules, ''))
}
