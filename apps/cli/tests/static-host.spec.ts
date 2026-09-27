/**
 * FL-21：静态托管语义——文件命中、SPA 回落 index.html、目录穿越 403、
 * 坏路径 400、tap 注入 bootstrap（token）。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStaticHost } from '../src/lib/static-host.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeDist(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-static-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true }).catch(() => undefined)
    await writeFile(join(root, name), content, 'utf8')
  }
  return root
}

describe('createStaticHost', () => {
  it('dist 缺失时返回 null（宿主保持纯 API 行为）', async () => {
    const host = await createStaticHost({ root: join(await mkdtemp(join(tmpdir(), 'studyclaw-empty-')), 'nope') })
    expect(host).toBeNull()
  })

  it('命中文件并给出正确 MIME', async () => {
    const root = await makeDist({ 'index.html': '<html><head></head><body>ok</body></html>', 'app.js': 'console.log(1)' })
    const host = (await createStaticHost({ root }))!
    const html = await host.respond('/')
    expect(html?.status).toBe(200)
    expect(html?.contentType).toContain('text/html')
    const js = await host.respond('/app.js')
    expect(js?.contentType).toContain('text/javascript')
  })

  it('SPA 回落：无扩展名路由未命中 → index.html', async () => {
    const root = await makeDist({ 'index.html': '<html><head><title>t</title></head></html>' })
    const host = (await createStaticHost({ root }))!
    const hit = await host.respond('/some/spa/route')
    expect(hit?.status).toBe(200)
    expect(String(hit?.body)).toContain('<title>t</title>')
  })

  it('有扩展名但文件不存在 → null（交回 404）', async () => {
    const root = await makeDist({ 'index.html': 'x' })
    const host = (await createStaticHost({ root }))!
    expect(await host.respond('/missing.png')).toBeNull()
  })

  it('目录穿越 → 403，不解码后再穿越', async () => {
    const root = await makeDist({ 'index.html': 'x' })
    const host = (await createStaticHost({ root }))!
    await writeFile(join(root, 'secret.txt'), 's', 'utf8')
    const outside = root.replace(/[\\/]+$/, '') + '\\..\\..\\..\\Windows\\win.ini'
    for (const path of ['/%2e%2e/%2e%2e/etc/passwd', outside.replaceAll('\\', '/').replace(root, '')]) {
      const hit = await host.respond(path)
      expect(hit === null || hit.status === 403).toBe(true)
    }
  })

  it('FL-30：index.html 注入 bootstrap tap（token）', async () => {
    const root = await makeDist({ 'index.html': '<html><head><meta charset="utf-8"></head><body></body></html>' })
    const host = (await createStaticHost({ root, bootstrap: { token: 'tk-123' } }))!
    const hit = await host.respond('/')
    expect(String(hit?.body)).toContain('window.__STUDYCLAW__={"token":"tk-123"}')
  })

  it('bootstrap 为 null 时不注入', async () => {
    const root = await makeDist({ 'index.html': '<html><head></head></html>' })
    const host = (await createStaticHost({ root, bootstrap: null }))!
    expect(String((await host.respond('/'))?.body)).not.toContain('__STUDYCLAW__')
  })

  it('C-12：HTML no-cache、hash 资产 immutable、全局 nosniff', async () => {
    const root = await makeDist({
      'index.html': '<html><head></head><body></body></html>',
      '_next/static/chunks/main-1a2b3c4d5e.js': 'console.log(1)',
      'plain.js': 'console.log(2)',
    })
    const host = (await createStaticHost({ root, bootstrap: { token: 'tk' } }))!
    const html = (await host.respond('/'))!
    expect(html.headers?.['Cache-Control']).toBe('no-cache, must-revalidate')
    expect(html.headers?.['X-Content-Type-Options']).toBe('nosniff')
    const hashed = (await host.respond('/_next/static/chunks/main-1a2b3c4d5e.js'))!
    expect(hashed.headers?.['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(hashed.headers?.['X-Content-Type-Options']).toBe('nosniff')
    const plain = (await host.respond('/plain.js'))!
    expect(plain.headers?.['Cache-Control']).toBe('public, max-age=3600')
  })
})
