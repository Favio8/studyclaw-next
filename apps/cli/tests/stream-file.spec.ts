import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { pipeFileResponse } from '../src/lib/stream-file.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('资料流文件错误隔离', () => {
  it('文件在 stat 后消失时，连接关闭而服务仍可处理下一请求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-file-stream-'))
    roots.push(root)
    await writeFile(join(root, 'good.pdf'), 'PDF FIXTURE')
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/pdf' })
      pipeFileResponse(join(root, request.url === '/missing' ? 'missing.pdf' : 'good.pdf'), response)
    })
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const base = `http://127.0.0.1:${address.port}`
    try {
      await expect(fetch(`${base}/missing`).then(response => response.text())).rejects.toThrow()
      expect(await fetch(`${base}/good`).then(response => response.text())).toBe('PDF FIXTURE')
    } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())) }
  })
});
