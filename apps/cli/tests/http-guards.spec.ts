/**
 * 服务入口防护回归：readRequestBody 跨 TCP chunk 的多字节 UTF-8 完整性
 * （P0-1 乱码根因）、体积上限（P1-5）、读超时与提前断连保护（NEW-002），
 * loopback Origin 白名单（SEC-1），以及错误消息凭据净化（BUG-005）。
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { isLoopbackOrigin, PayloadTooLargeError, readRequestBody, RequestBodyTimeoutError, sanitizeErrorMessage } from '../src/lib/http-guards.ts'

class FakeRequest extends EventEmitter {
  destroy(): void {
    this.emit('close')
  }
}

function writeChunks(request: FakeRequest, chunks: Buffer[]): void {
  queueMicrotask(() => {
    for (const chunk of chunks) request.emit('data', chunk)
    request.emit('end')
  })
}

describe('readRequestBody', () => {
  const text = '请确认这是《Harness 讲义》吗？確認教程 c_harness_2 → 70%'
  const bytes = Buffer.from(text, 'utf8')

  it('在任意字节边界切分都能无损重组多字节中文', async () => {
    for (let cut = 1; cut < bytes.length; cut += 7) {
      const request = new FakeRequest()
      const pending = readRequestBody(request as unknown as IncomingMessage)
      writeChunks(request, [bytes.subarray(0, cut), bytes.subarray(cut)])
      await expect(pending).resolves.toBe(text)
    }
  })

  it('逐字节逐段切分（最坏情况，每段都断在字符内部）也保持一致', async () => {
    const request = new FakeRequest()
    const pending = readRequestBody(request as unknown as IncomingMessage)
    writeChunks(request, [...bytes].map(byte => Buffer.from([byte])))
    await expect(pending).resolves.toBe(text)
  })

  it('超过上限抛 PayloadTooLargeError（丢弃余量但不撕连接）', async () => {
    const request = new FakeRequest()
    const pending = readRequestBody(request as unknown as IncomingMessage, 16)
    queueMicrotask(() => {
      request.emit('data', Buffer.alloc(32))
      request.emit('data', Buffer.alloc(32))
      request.emit('end')
    })
    await expect(pending).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('NEW-002：请求体迟迟不发完时超时拒绝（Slowloris 防护）', async () => {
    const request = new FakeRequest()
    const pending = readRequestBody(request as unknown as IncomingMessage, 1024, 50)
    queueMicrotask(() => {
      request.emit('data', Buffer.from('half-'))
      // 不发 end，模拟只发一半请求体的慢速客户端。
    })
    await expect(pending).rejects.toBeInstanceOf(RequestBodyTimeoutError)
  })

  it('NEW-002：连接在 body 完成前断开时立即拒绝而不是挂死', async () => {
    const request = new FakeRequest()
    const pending = readRequestBody(request as unknown as IncomingMessage, 1024)
    queueMicrotask(() => {
      request.emit('data', Buffer.from('abc'))
      request.emit('close')
    })
    await expect(pending).rejects.toThrow('closed before body completed')
  })

  it('NEW-002：正常完成后 close 不影响结果（settled 只结算一次）', async () => {
    const request = new FakeRequest()
    const pending = readRequestBody(request as unknown as IncomingMessage, 1024)
    queueMicrotask(() => {
      request.emit('data', Buffer.from('ok'))
      request.emit('end')
      request.emit('close')
    })
    await expect(pending).resolves.toBe('ok')
  })
})

describe('sanitizeErrorMessage（BUG-005）', () => {
  it('净化 URL 查询参数中的密钥/token', () => {
    expect(sanitizeErrorMessage('fetch failed for https://api.com/v1/chat?api_key=sk-secret123'))
      .toBe('fetch failed for https://api.com/v1/chat?api_key=***')
    expect(sanitizeErrorMessage('GET /v1/models?token=abcdef123456789&x=1 failed'))
      .toBe('GET /v1/models?token=***&x=1 failed')
  })

  it('净化 Bearer 头与厂商前缀密钥', () => {
    expect(sanitizeErrorMessage('Authorization: Bearer sk-abcdef1234567890'))
      .toBe('Authorization: Bearer ***')
    expect(sanitizeErrorMessage('invalid key sk-abcdefghijklmnop1234 provided'))
      .toBe('invalid key sk-*** provided')
    expect(sanitizeErrorMessage('bad AIzaSyA1234567890abcdefghij key')).toBe('bad AIza*** key')
    expect(sanitizeErrorMessage('gsk_0123456789abcdefghijklmnop rejected')).toBe('gsk_*** rejected')
  })

  it('净化 URL 用户信息段，正常中文错误消息原样保留', () => {
    expect(sanitizeErrorMessage('connect ECONNREFUSED https://user:p4ssw0rd@internal.host/api'))
      .toBe('connect ECONNREFUSED https://***:***@internal.host/api')
    const plain = 'ENOENT: no such file C:\\Users\\Favio\\.studyclaw\\creds.json'
    expect(sanitizeErrorMessage(plain)).toBe(plain)
  })
})

describe('isLoopbackOrigin', () => {
  it('放行本机来源与无 Origin 的 CLI/curl 客户端', () => {
    expect(isLoopbackOrigin(undefined)).toBe(true)
    expect(isLoopbackOrigin('')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true)
    expect(isLoopbackOrigin('https://localhost:8080')).toBe(true)
  })

  it('拒绝恶意网页跨站来源与畸形值', () => {
    expect(isLoopbackOrigin('http://evil.com')).toBe(false)
    expect(isLoopbackOrigin('null')).toBe(false)
    expect(isLoopbackOrigin('file:///etc/passwd')).toBe(false)
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
  })
})
