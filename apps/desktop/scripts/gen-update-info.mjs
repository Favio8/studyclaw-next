#!/usr/bin/env node
/**
 * 生成 electron-builder 的自动更新元数据（latest*.yml）。
 *
 * 为什么自己生成：CI 上（存在 git tag 时）electron-builder 的隐式发布会被
 * generic provider 吞掉 update info，`--publish never` 也不落盘；本机与 CI
 * 行为不一致会让发布流水线时灵时不灵。格式与 electron-builder 输出一致
 * （sha512 = base64），客户端 electron-updater 按此校验。
 *
 * 用法：node scripts/gen-update-info.mjs --target win|mac|linux [--dist dist]
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const target = argOf('--target')
const dist = resolve(desktop, argOf('--dist', 'dist'))
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDate = new Date().toISOString()

if (!['win', 'mac', 'linux'].includes(target)) {
  console.error('[update-info] --target 必须是 win|mac|linux')
  process.exit(1)
}

/** electron-builder 的 sha512 是 base64 摘要。 */
const sha512 = file => createHash('sha512').update(readFileSync(file)).digest('base64')
const sizeOf = file => statSync(file).size

function pick(suffix) {
  const files = readdirSync(dist).filter(f => f.endsWith(suffix)).sort()
  if (files.length === 0) {
    console.error(`[update-info] dist 里没有 *${suffix} 产物，无法生成 update info`)
    process.exit(1)
  }
  return files[files.length - 1]
}

/** 单文件条目（win/linux 的 files 数组只有一项）。 */
function entry(file) {
  return { url: file, sha512: sha512(join(dist, file)), size: sizeOf(join(dist, file)) }
}

function render(files) {
  const lines = files.map(f => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}`).join('\n')
  return `version: ${version}\nfiles:\n${lines}\npath: ${files[0].url}\nsha512: ${files[0].sha512}\nreleaseDate: '${releaseDate}'\n`
}

let outFile
let files
if (target === 'win') {
  files = [entry(pick('-setup.exe'))]
  outFile = 'latest.yml'
} else if (target === 'mac') {
  // zip 是自动更新载荷；两个 arch 都进 files，path 取排序后的第一个。
  files = readdirSync(dist).filter(f => f.endsWith('.zip')).sort().map(entry)
  if (files.length === 0) {
    console.error('[update-info] dist 里没有 *.zip 产物，无法生成 latest-mac.yml')
    process.exit(1)
  }
  outFile = 'latest-mac.yml'
} else {
  files = [entry(pick('.AppImage'))]
  outFile = 'latest-linux.yml'
}

writeFileSync(join(dist, outFile), render(files))
console.log(`[update-info] ${outFile} OK ← ${files.map(f => f.url).join(', ')}`)
