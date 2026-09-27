/**
 * fetch-url-safe 回归（SEC-3）：协议白名单、内网地址封锁（含重定向逐跳校验、
 * IPv4-mapped IPv6、云元数据段）、重定向上限与错误脱敏。
 */

import { describe, expect, it } from 'vitest'
import { assertFetchableHttpUrl, assertPublicHost, BlockedUrlError, fetchUrlSafe, pinnedLookup } from '../src/fetch-url-safe.ts'

function fakeResponse(status: number, headers: Record<string, string> = {}, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => await Promise.resolve(body),
  }
}

describe('assertFetchableHttpUrl', () => {
  it('拒绝非 http(s) 与内嵌凭据', () => {
    expect(() => assertFetchableHttpUrl('file:///etc/passwd')).toThrow(BlockedUrlError)
    expect(() => assertFetchableHttpUrl('ftp://example.com/x')).toThrow(BlockedUrlError)
    expect(() => assertFetchableHttpUrl('http://user:pass@example.com/')).toThrow(BlockedUrlError)
    expect(() => assertFetchableHttpUrl('not a url')).toThrow(BlockedUrlError)
    expect(assertFetchableHttpUrl('https://example.com/doc').hostname).toBe('example.com')
  })
})

describe('assertPublicHost', () => {
  it('拒绝环回、私网、link-local、CGNAT 与 IPv4-mapped IPv6 字面量', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      await expect(assertPublicHost(host)).rejects.toThrow(BlockedUrlError)
    }
  })

  it('放行公网字面量，并按解析结果过滤私网域名', async () => {
    await expect(assertPublicHost('8.8.8.8')).resolves.toBeUndefined()
    await expect(assertPublicHost('2606:4700::1111')).resolves.toBeUndefined()
    const resolve = async (host: string) => host === 'evil.internal'
      ? [{ address: '192.168.0.7' }]
      : [{ address: '93.184.216.34' }, { address: '2606:4700::6810:85e5' }]
    await expect(assertPublicHost('example.com', resolve)).resolves.toBeUndefined()
    await expect(assertPublicHost('evil.internal', resolve)).rejects.toThrow('内网')
  })
})

describe('fetchUrlSafe', () => {
  const publicResolve = async () => [{ address: '93.184.216.34' }]

  it('直接返回公网页面内容', async () => {
    let requested = ''
    const html = await fetchUrlSafe('https://example.com/doc', {
      resolve: publicResolve,
      fetchImpl: async url => {
        requested = String(url)
        return fakeResponse(200, { 'content-type': 'text/html' }, '<h1>hi</h1>')
      },
    }).then(async r => await r.text())
    expect(html).toContain('hi')
    expect(requested).toBe('https://example.com/doc')
  })

  it('跟随 ≤3 跳公网重定向；重定向到内网被拒；超跳数报错', async () => {
    // 一跳到公网镜像：应到达。
    const mirror = async (url: URL) => new URL(url).host === 'a.example.com'
      ? fakeResponse(302, { location: 'https://b.example.com/target' })
      : fakeResponse(200, { 'content-type': 'text/html' }, 'landing')
    const okResult = await fetchUrlSafe('https://a.example.com/start', { resolve: publicResolve, fetchImpl: mirror })
    expect(await okResult.text()).toBe('landing')

    // 重定向到环回：SSF 阻断。
    const toLoopback = async () => fakeResponse(302, { location: 'http://127.0.0.1:9200/admin' })
    await expect(fetchUrlSafe('https://a.example.com/start', { resolve: publicResolve, fetchImpl: toLoopback }))
      .rejects.toThrow(BlockedUrlError)

    // 四连环 redirect → 超过 maxRedirects。
    const loop = async () => fakeResponse(302, { location: '/next' })
    await expect(fetchUrlSafe('https://a.example.com/round', { resolve: publicResolve, fetchImpl: loop, maxRedirects: 2 }))
      .rejects.toThrow('重定向次数过多')
  })

  it('网络失败不回显目标 URL（脱敏）', async () => {
    try {
      await fetchUrlSafe('https://secret-host.example.com/private-path', {
        resolve: publicResolve,
        fetchImpl: async () => { throw new Error('ECONNREFUSED simulated') },
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error instanceof Error && error.message).not.toContain('private-path')
      expect((error as Error).message).toContain('抓取失败')
    }
  })
})

describe('pinnedLookup（connect 层 IP pinning，DNS rebinding 根治）', () => {
  function callLookup(hostname: string): Promise<{ error: Error | null; address?: string; family?: number }> {
    return new Promise(resolve => {
      pinnedLookup(hostname, {}, (error, address, family) => resolve({ error: error ?? null, address, family }))
    })
  }

  it('解析到私网地址的域名在 lookup 内被拒（校验与拨号同源，无 TOCTOU 窗口）', async () => {
    const result = await callLookup('localhost')
    expect(result.error).toBeInstanceOf(BlockedUrlError)
    expect((result.error as Error).message).toContain('内网')
  })

  it('解析失败的域名报可读错误而不是崩溃', async () => {
    // 真实 NXDOMAIN 环境：dnsLookup 回 ENOTFOUND；DNS 劫持/通配解析环境：
    // 无效域名被引到 198.18.0.0/15 等 IANA 保留段，由 isForbiddenIpv4 拒下。
    // 两条路径都必须以 Error 回调，而不是抛异常打崩宿主或静默放行。
    const result = await callLookup('invalid.invalid.invalid.')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.address).toBeUndefined()
  })
})
