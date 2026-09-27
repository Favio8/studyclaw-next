/**
 * 加固3 回归：`courses.ingestUrl` 的内容类型白名单。旧实现写成
 * `if (!ALLOWED.test(ct) && ct !== '') throw`——服务端**不声明** Content-Type
 * 时（空串）整段校验被绕过，PDF/zip/任意二进制都能落进 sources 再喂给 LLM。
 * 现在策略是严格拒绝：白名单外的类型和"未声明类型"都拒绝，且不落任何文件。
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchUrlSafeMock } = vi.hoisted(() => ({ fetchUrlSafeMock: vi.fn() }))
vi.mock('../src/fetch-url-safe.ts', () => ({ fetchUrlSafe: fetchUrlSafeMock }))

import { createCourseService } from '../src/course.ts'

function fakeResponse(contentType: string | null, body = '<html><head></head><body><h1>标题</h1><p>正文</p></body></html>') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  }
}

let root: string
let ws: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyclaw-ingest-url-'))
  process.env.STUDYCLAW_HOME = join(root, 'home')
  ws = join(root, 'ws')
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'seed.md'), '# 种子资料\n\n内容。\n', 'utf8')
  fetchUrlSafeMock.mockReset()
})

const teardown = async (): Promise<void> => {
  delete process.env.STUDYCLAW_HOME
  await rm(root, { recursive: true, force: true })
}

describe('courses.ingestUrl 内容类型白名单（加固3）', () => {
  it('text/html（带 charset 参数）正常摄取并落盘 sources/web_*.md', async () => {
    fetchUrlSafeMock.mockResolvedValue(fakeResponse('text/html; charset=utf-8'))
    const service = createCourseService(async () => null)
    const created = await service.createCourse(ws, '白名单测试', [])
    const result = await service.ingestUrl(ws, created.course, 'https://example.com/doc', null) as { added: string }
    // 未配置 LLM 时不启动构建，但文件必须已落盘（added 是绝对路径）。
    expect(basename(result.added)).toMatch(/^web_[0-9a-f]{8}\.md$/)
    expect(await readdir(join(ws, 'sources'))).toContain(basename(result.added))
    await teardown()
  })

  it('服务端不声明 Content-Type → 拒绝且不落盘（旧实现由此放过二进制）', async () => {
    fetchUrlSafeMock.mockResolvedValue(fakeResponse(null))
    const service = createCourseService(async () => null)
    const created = await service.createCourse(ws, '无类型测试', [])
    await expect(service.ingestUrl(ws, created.course, 'https://example.com/blob', null))
      .rejects.toThrow(/未声明 Content-Type/)
    expect(await readdir(join(ws, 'sources')).catch(() => [])).toEqual([])
    await teardown()
  })

  it('application/pdf → 拒绝且不落盘', async () => {
    fetchUrlSafeMock.mockResolvedValue(fakeResponse('application/pdf'))
    const service = createCourseService(async () => null)
    const created = await service.createCourse(ws, 'PDF 测试', [])
    await expect(service.ingestUrl(ws, created.course, 'https://example.com/a.pdf', null))
      .rejects.toThrow(/不支持的内容类型: application\/pdf/)
    expect(await readdir(join(ws, 'sources')).catch(() => [])).toEqual([])
    await teardown()
  })

  it('application/json → 拒绝（白名单只放行文本类）', async () => {
    fetchUrlSafeMock.mockResolvedValue(fakeResponse('application/json; charset=utf-8'))
    const service = createCourseService(async () => null)
    const created = await service.createCourse(ws, 'JSON 测试', [])
    await expect(service.ingestUrl(ws, created.course, 'https://example.com/data.json', null))
      .rejects.toThrow(/不支持的内容类型: application\/json/)
    expect(await readdir(join(ws, 'sources')).catch(() => [])).toEqual([])
    await teardown()
  })

  it('text/markdown 正常放行', async () => {
    fetchUrlSafeMock.mockResolvedValue(fakeResponse('text/markdown', '# 直接 Markdown\n\n正文。\n'))
    const service = createCourseService(async () => null)
    const created = await service.createCourse(ws, 'MD 测试', [])
    const result = await service.ingestUrl(ws, created.course, 'https://example.com/doc.md', null) as { added: string }
    expect(basename(result.added)).toMatch(/^web_[0-9a-f]{8}\.md$/)
    await teardown()
  })
})
