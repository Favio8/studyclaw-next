/**
 * 服务入口防护回归：readRequestBody 跨 TCP chunk 的多字节 UTF-8 完整性
 * （P0-1 乱码根因）、体积上限（P1-5），以及 loopback Origin 白名单（SEC-1）。
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { isLoopbackOrigin, PayloadTooLargeError, readRequestBody } from '../src/lib/http-guards.ts'

class FakeRequest extends EventEmitter {}

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
