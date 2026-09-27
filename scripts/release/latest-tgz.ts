/**
 * 从 artifacts/ 挑出最新的 studyclaw-cli tgz。文件名内嵌 semver，必须按数值
 * 逐段比较版本——字典序在位数变化时会选错包（"1.2.9" > "1.2.10"），导致
 * publint/安装验证校验的是上一个旧版本。
 * @module scripts/release/latest-tgz
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const TGZ_RE = /^studyclaw-cli-(\d+)\.(\d+)\.(\d+)(.*)\.tgz$/

export interface CliTarball {
  /** 文件名（用于日志）。 */
  name: string
  /** 绝对路径（用于消费）。 */
  path: string
}

export function latestCliTarball(outDir: string): CliTarball | null {
  const candidates = readdirSync(outDir).filter(name => TGZ_RE.test(name))
  if (candidates.length === 0) return null
  const key = (name: string): [number, number, number, string] => {
    const match = TGZ_RE.exec(name)!
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
  }
  candidates.sort((a, b) => {
    const [majorA, minorA, patchA, suffixA] = key(a)
    const [majorB, minorB, patchB, suffixB] = key(b)
    if (majorA !== majorB) return majorB - majorA
    if (minorA !== minorB) return minorB - minorA
    if (patchA !== patchB) return patchB - patchA
    return suffixB.localeCompare(suffixA)
  })
  const name = candidates[0]!
  return { name, path: join(outDir, name) }
}
