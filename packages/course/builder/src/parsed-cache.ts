/**
 * MinerU 解析产物缓存（PRD 需求一 F1.5）：内容寻址 + manifest 失效判定。
 *
 * - 产物文件 `<sha256前12>-<tier>.md` 内容寻址：源文件没变时跨构建/跨档位
 *   切换复用（切回旧档位即命中旧文件），不重复起 MinerU 进程；
 * - `manifest.json`（relPath → {sha256, engine, tier, out}）记录每个资料
 *   上次由哪个引擎/档位产出：引擎或档位变更、源文件变化即失效，下次构建
 *   重新抽取。auto 模式下 MinerU 失败回落的文件记 builtin——下次构建会
 *   重试 MinerU（自愈），不会把 builtin 结果冒充成 MinerU 永久钉住。
 * - 与 `.checksums` 分离：后者是 builder 增量契约，混入引擎字段会影响旧
 *   课程兼容；manifest 独立可弃。
 * @module @studyclaw/course-builder/src/parsed-cache
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ParsedEngine = 'mineru' | 'builtin'

export interface ParsedCacheEntry {
  readonly sha256: string
  readonly engine: ParsedEngine
  readonly tier: string
  /** 产物文件名（builtin 回落为 null——builtin 不落缓存文件）。 */
  readonly out: string | null
}

/** relPath（sources 下相对路径）→ 上次抽取记录。 */
export type ParsedManifest = Record<string, ParsedCacheEntry>

export function parsedDirOf(stateDir: string): string {
  return join(stateDir, 'parsed')
}

/** 内容寻址的产物文件名：`<sha256前12>-<tier>.md`。 */
export function parsedFileName(sha256: string, tier: string): string {
  const hex = sha256.startsWith('sha256:') ? sha256.slice('sha256:'.length) : sha256
  return `${hex.slice(0, 12)}-${tier}.md`
}

export async function loadParsedManifest(stateDir: string): Promise<ParsedManifest> {
  const text = await readFile(join(parsedDirOf(stateDir), 'manifest.json'), 'utf8').catch(() => '')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const manifest: ParsedManifest = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      if (typeof entry['sha256'] !== 'string' || typeof entry['engine'] !== 'string' || typeof entry['tier'] !== 'string') continue
      if (entry['engine'] !== 'mineru' && entry['engine'] !== 'builtin') continue
      manifest[key] = {
        sha256: entry['sha256'],
        engine: entry['engine'],
        tier: entry['tier'],
        out: typeof entry['out'] === 'string' ? entry['out'] : null,
      }
    }
    return manifest
  } catch {
    // 损坏的 manifest 视为空（下次构建全量重判），不阻塞构建。
    return {}
  }
}

export async function saveParsedManifest(stateDir: string, manifest: ParsedManifest): Promise<void> {
  const dir = parsedDirOf(stateDir)
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'manifest.json')
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

/** 读内容寻址缓存；不存在返回 null。 */
export async function readParsedText(stateDir: string, fileName: string): Promise<string | null> {
  const text = await readFile(join(parsedDirOf(stateDir), fileName), 'utf8').catch(() => '')
  return text.trim() === '' ? null : text
}

/** 写内容寻址缓存，返回落盘文件名。 */
export async function writeParsedText(stateDir: string, fileName: string, markdown: string): Promise<string> {
  const dir = parsedDirOf(stateDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), markdown, 'utf8')
  return fileName
}

/**
 * manifest 失效判定：entry 与当前 (sha, engine, tier) 不一致即需要重新抽取。
 * 缺失 entry 同样视为失效（首建或 manifest 被删）。
 */
export function parsedEntryStale(entry: ParsedCacheEntry | undefined, sha256: string, engine: ParsedEngine, tier: string): boolean {
  if (entry === undefined) return true
  return entry.sha256 !== sha256 || entry.engine !== engine || entry.tier !== tier
}
