/**
 * FL-21：SPA 静态托管（`studyclaw serve` 自带 Web UI，与 dsh
 * `host/frontend-static` 同语义）：防目录穿越、未命中回落 index.html（SPA
 * 路由）、MIME 映射、index tap 注入启动参数（FL-30：token 由这里注入
 * `window.__STUDYCLAW__`，同源页面无需跨域读取）。dist 根不存在时返回 null，
 * 宿主保持旧行为（纯 API 404）。
 * @module @studyclaw/cli/lib/static-host
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface StaticHostOptions {
  /** Static dist root（apps/web 的 export 产物目录）。 */
  root: string
  /** 注入 `window.__STUDYCLAW__` 的启动参数（token 等）；null 不注入。 */
  bootstrap?: Record<string, unknown> | null
}

export interface StaticHit {
  status: number
  body: Buffer | string
  contentType: string
}

export interface StaticHost {
  /** 处理一个 GET/HEAD 路径；返回 null 表示交回调用方的默认 404。 */
  respond(pathname: string): Promise<StaticHit | null>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream' : 'application/octet-stream'
}

/** 注入启动参数：紧跟 `<head>` 之后（旧导出没有 `<head>` 时整体前置）。 */
function withBootstrapTap(html: string, bootstrap: Record<string, unknown> | null): string {
  if (bootstrap === null) return html
  const tap = `<script>window.__STUDYCLAW__=${JSON.stringify(bootstrap)}</script>`
  const headIndex = html.indexOf('<head>')
  return headIndex >= 0
    ? html.slice(0, headIndex + 6) + tap + html.slice(headIndex + 6)
    : tap + html
}

export async function createStaticHost(options: StaticHostOptions): Promise<StaticHost | null> {
  const root = resolve(options.root)
  if ((await stat(root).catch(() => null))?.isDirectory() !== true) return null
  const indexCache = new Map<string, string>()

  return {
    async respond(pathname: string): Promise<StaticHit | null> {
      // 只接受安全路径：解码后必须仍然落在 dist 根内（防穿越，403 语义）。
      let decoded: string
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        return { status: 400, body: JSON.stringify({ error: { code: 'bad-request', message: 'malformed path', details: null } }), contentType: MIME['.json']! }
      }
      if (decoded.includes('\0')) return { status: 400, body: JSON.stringify({ error: { code: 'bad-request', message: 'malformed path', details: null } }), contentType: MIME['.json']! }
      const candidate = resolve(root, `.${decoded.replaceAll('\\', '/')}`)
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        return { status: 403, body: JSON.stringify({ error: { code: 'forbidden', message: 'path traversal is not allowed', details: null } }), contentType: MIME['.json']! }
      }
      let filePath = candidate
      const info = await stat(filePath).catch(() => null)
      if (info === null || info.isDirectory()) {
        // SPA 回落：无扩展名的路由未命中 → index.html。
        if (info === null && /\.[A-Za-z0-9]+$/.test(decoded)) return null
        filePath = join(root, 'index.html')
        const indexInfo = await stat(filePath).catch(() => null)
        if (indexInfo === null || !indexInfo.isFile()) return null
      }
      const file = await readFile(filePath).catch(() => null)
      if (file === null) return null
      let body: Buffer | string = file
      if (filePath.toLowerCase().endsWith('.html')) {
        // index.html 按 (root, mtime) 缓存 tap 注入结果，避免每请求重读重注入。
        const cacheKey = `${filePath}:${(await stat(filePath)).mtimeMs}`
        let injected = indexCache.get(cacheKey)
        if (injected === undefined) {
          injected = withBootstrapTap(file.toString('utf8'), options.bootstrap ?? null)
          if (indexCache.size > 8) indexCache.clear()
          indexCache.set(cacheKey, injected)
        }
        body = injected
      }
      return { status: 200, body, contentType: contentTypeOf(filePath) }
    },
  }
}
