/**
 * Hardened outbound fetch for user/LLM-supplied URLs (SEC-3):
 * - http(s) only, no embedded credentials;
 * - connect-layer IP pinning: every resolved address is validated inside the
 *   custom DNS `lookup`, and the connection dials exactly the validated IP —
 *   the check-to-connect DNS rebinding window is closed;
 * - every hop (including redirects) must resolve to a public IP — loopback,
 *   RFC1918/private, CGNAT, link-local, cloud-metadata and IANA
 *   special-purpose (TEST-NET/benchmarking/reserved) ranges are refused,
 *   closing the SSRF/port-scan channel (`discoverModels` 允许私网是因为本地
 *   模型服务器是一等场景，而这里的抓取内容会进入学习上下文，风险不同);
 * - redirects are followed manually with re-validation and capped;
 * - response bodies are capped (8MB) so a hostile server cannot balloon host memory;
 * - error messages never echo the target URL back to the RPC caller.
 */

import { isIP } from 'node:net'
import { lookup as lookupPromise } from 'node:dns/promises'
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

const USER_AGENT = 'StudyClaw/0.1'
const FETCH_TIMEOUT_MS = 15_000
/** 响应体上限：抓取内容会进学习上下文，8MB 已远超网页正文需要。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export class BlockedUrlError extends Error {
  readonly code = 'blocked-url'
  constructor(reason: string) {
    super(`该地址被拒绝抓取（${reason}）`)
    this.name = 'BlockedUrlError'
  }
}

/** Scheme + userinfo sanity before anything touches the network. */
export function assertFetchableHttpUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new BlockedUrlError('不是合法的 URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new BlockedUrlError('只支持 http/https')
  if (parsed.username !== '' || parsed.password !== '') throw new BlockedUrlError('不允许内嵌用户名或密码')
  return parsed
}

function isForbiddenIpv4(ip: string): boolean {
  const parts = ip.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // 本机/内网/环回
  if (a === 169 && b === 254) return true // link-local / 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 私网段
  if (a === 192 && b === 168) return true // 私网段
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  // IANA 特殊用途段：全球不可路由，正常抓取永远到不了合法站点，但 DNS 劫持/
  // 通配解析环境会把无效域名引到这些段（如 198.18.0.x）——一并拒绝，既收窄
  // SSRF 面也让解析失败用例不依赖所处网络环境的 DNS 行为。
  if (a >= 240) return true // 保留段 240.0.0.0/4（含有限广播 255.255.255.255）
  if (a === 198 && b >= 18 && b <= 19) return true // benchmarking 198.18.0.0/15
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3 203.0.113.0/24
  if (a === 192 && b === 88 && c === 99) return true // 已废弃的 6to4 中继 anycast 192.88.99.0/24
  return false
}

function isForbiddenIpv6(ip: string): boolean {
  const lowered = ip.toLowerCase()
  if (lowered === '::' || lowered === '::1') return true
  if (lowered.startsWith('fc') || lowered.startsWith('fd')) return true // ULA fd00::/8 起
  if (/^fe[89ab]/.test(lowered)) return true // link-local fe80::/10
  if (lowered.startsWith('::ffff:')) return isForbiddenIpv4(lowered.slice(7)) // IPv4-mapped
  return false
}

/** Reject hostnames whose resolved addresses are not global unicast. */
export async function assertPublicHost(
  hostname: string,
  resolve: (host: string) => Promise<Array<{ address: string }>> = async host => await lookupPromise(host, { all: true, verbatim: true }),
): Promise<void> {
  const family = isIP(hostname)
  if (family === 4) {
    if (isForbiddenIpv4(hostname)) throw new BlockedUrlError('目标是不允许访问的内网地址')
    return
  }
  if (family === 6) {
    if (isForbiddenIpv6(hostname)) throw new BlockedUrlError('目标是不允许访问的内网地址')
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await resolve(hostname)
  } catch {
    throw new BlockedUrlError('域名无法解析')
  }
  if (addresses.length === 0) throw new BlockedUrlError('域名无法解析')
  for (const { address } of addresses) {
    if (isIP(address) === 4 ? isForbiddenIpv4(address) : isForbiddenIpv6(address)) {
      throw new BlockedUrlError('目标域名解析到不允许访问的内网地址')
    }
  }
}

type FetchLike = (url: URL, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/**
 * connect 层 IP pinning（残余风险 #1 根治）：断言与拨号共用同一次解析结果。
 * 旧实现"先 assertPublicHost 校验、再 fetch（内部二次解析）"，攻击者可用低
 * TTL DNS 在两步之间换地址（经典 DNS rebinding TOCTOU）。现在自定义 lookup
 * 在回调前把**每个**解析地址过公网校验，net.connect 拨号的正是校验过的那个
 * IP——校验与连接之间不再存在窗口。字面量 IP 由 net.connect 跳过 lookup，
 * 由每跳前的 assertPublicHost 直接校验字面量，同样无窗口。TLS 的 SNI/证书
 * 校验仍使用原始主机名，身份验证不受 pinning 影响。
 */
export function pinnedLookup(
  hostname: string,
  _options: unknown,
  callback: (error: NodeJS.ErrnoException | Error | null, address?: string, family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error !== null) {
      callback(error)
      return
    }
    const list = addresses ?? []
    if (list.length === 0) {
      callback(new Error('域名无法解析'))
      return
    }
    for (const { address } of list) {
      if (isIP(address) === 4 ? isForbiddenIpv4(address) : isForbiddenIpv6(address)) {
        callback(new BlockedUrlError('目标域名解析到不允许访问的内网地址'))
        return
      }
    }
    callback(null, list[0]!.address, list[0]!.family)
  })
}

// 解压输出与压缩体同受上限约束：8MB 压缩体的 gzip 炸弹可膨胀至 GB 级，
// 同步 gunzipSync 无输出上限会打爆宿主内存且阻塞事件循环。流式解压边计数
// 边截断，超限即销毁流。
async function decompressBody(body: Buffer, encoding: string | undefined): Promise<Buffer> {
  const stream = encoding === 'gzip'
    ? createGunzip()
    : encoding === 'deflate'
      ? createInflate()
      : encoding === 'br'
        ? createBrotliDecompress()
        : null
  if (stream === null) return body
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > MAX_RESPONSE_BYTES) {
        settled = true
        stream.destroy()
        reject(new BlockedUrlError('解压后的响应体超过大小上限'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => {
      // 主动销毁（超限）也会走这里；settled 已置位时忽略。
      if (settled) return
      settled = true
      reject(new BlockedUrlError('响应解压失败'))
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    stream.end(body)
  })
}

/**
 * node:http(s) 版 FetchLike（默认实现）：经 `lookup` 选项接入 pinnedLookup，
 * 并给响应体设 8MB 上限——旧默认 `fetch().text()` 会把任意大小的响应整体
 * 缓冲进内存。未发送 Accept-Encoding 时多数服务器返回未压缩正文，这里仍
 * 兼容 gzip/deflate/br 以防强制压缩的服务器。
 */
const pinnedFetch: FetchLike = (url, init) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET',
    headers: { ...(init?.headers ?? {}) },
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
    lookup: pinnedLookup as never,
  }, response => {
    const status = response.statusCode ?? 0
    const headers = {
      get: (name: string): string | null => response.headers[name.toLowerCase()]?.toString() ?? null,
    }
    const chunks: Buffer[] = []
    let total = 0
    let failure: Error | null = null
    response.on('data', (chunk: Buffer) => {
      if (failure !== null) return
      total += chunk.length
      if (total > MAX_RESPONSE_BYTES) {
        failure = new BlockedUrlError('响应体超过大小上限')
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    response.on('end', async () => {
      if (failure !== null) {
        reject(failure)
        return
      }
      try {
        const body = await decompressBody(Buffer.concat(chunks), headers.get('content-encoding') ?? undefined)
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers,
          text: async () => await Promise.resolve(body.toString('utf8')),
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    response.on('error', error => reject(error))
  })
  request.on('error', error => reject(error))
  request.end()
})

/**
 * GET with capped, revalidated redirect following. Caller decides what to do
 * with non-2xx statuses; network failures surface as a sanitized error.
 */
export async function fetchUrlSafe(
  rawUrl: string,
  options: {
    maxRedirects?: number
    fetchImpl?: FetchLike
    resolve?: (host: string) => Promise<Array<{ address: string }>>
  } = {},
): Promise<{ status: number; ok: boolean; text: () => Promise<string>; headers: { get(name: string): string | null } }> {
  const doFetch = options.fetchImpl ?? pinnedFetch
  let url = assertFetchableHttpUrl(rawUrl)
  const maxHops = options.maxRedirects ?? 3
  for (let hop = 0; ; hop += 1) {
    await assertPublicHost(url.hostname, options.resolve)
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await doFetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      if (error instanceof BlockedUrlError) throw error
      throw new Error('网页抓取失败（请检查网络连接）')
    }
    if (response.status >= 300 && response.status < 400) {
      if (hop >= maxHops) throw new BlockedUrlError('重定向次数过多')
      const location = response.headers.get('location')
      if (location === null) throw new BlockedUrlError('重定向缺少目标地址')
      url = assertFetchableHttpUrl(new URL(location, url).toString()) // 下一跳重新过协议/凭据校验
      continue
    }
    return response as unknown as { status: number; ok: boolean; text: () => Promise<string>; headers: { get(name: string): string | null } }
  }
}
