/**
 * Hardened outbound fetch for user/LLM-supplied URLs (SEC-3):
 * - http(s) only, no embedded credentials;
 * - every hop (including redirects) must resolve to a public IP — loopback,
 *   RFC1918/private, CGNAT, link-local and cloud-metadata ranges are refused,
 *   closing the SSRF/port-scan channel (`discoverModels` 允许私网是因为本地
 *   模型服务器是一等场景，而这里的抓取内容会进入学习上下文，风险不同);
 * - redirects are followed manually with re-validation and capped;
 * - error messages never echo the target URL back to the RPC caller.
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const USER_AGENT = 'StudyClaw/0.1'
const FETCH_TIMEOUT_MS = 15_000

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
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // 本机/内网/环回
  if (a === 169 && b === 254) return true // link-local / 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 私网段
  if (a === 192 && b === 168) return true // 私网段
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
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
  resolve: (host: string) => Promise<Array<{ address: string }>> = async host => await lookup(host, { all: true, verbatim: true }),
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
  const doFetch = options.fetchImpl ?? (async (inner: URL, init?: Parameters<typeof fetch>[1]) => await fetch(inner, init) as unknown as Awaited<ReturnType<FetchLike>>)
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
