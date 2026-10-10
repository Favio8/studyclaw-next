/**
 * PDF 解析降级链（PRD 需求一）：
 * - auto：MinerU 成功用 MinerU；失败静默回落内置 pdf-parse 并如实报告 builtin；
 * - mineru（强制）：失败抛 ExtractionError（builder 记 degraded），不用内置冒充；
 * - builtin / null：完全不碰 MinerU。
 * PDF fixture 用 pdf-lib 真建（与 extract.spec.ts 同 pattern），mineru 模块 mock。
 */

import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const { parseWithMineruMock, MineruErrorMock } = vi.hoisted(() => {
  class MineruErrorMock extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
      this.name = 'MineruError'
    }
  }
  return { parseWithMineruMock: vi.fn(), MineruErrorMock }
})
vi.mock('../src/mineru.ts', () => ({
  parseWithMineru: parseWithMineruMock,
  MineruError: MineruErrorMock,
}))

import { extractTextToMarkdown, extractTextToMarkdownWithEngine, ExtractionError } from '../src/index.ts'
import type { ParseEngineOptions } from '../src/mineru.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  parseWithMineruMock.mockReset()
})

function options(engine: ParseEngineOptions['engine'], tier: ParseEngineOptions['tier'] = 'basic'): ParseEngineOptions {
  return { engine, tier, timeoutSec: 120, concurrency: 1 }
}

async function pdfFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-fallback-'))
  tmpRoots.push(root)
  const course = join(root, 'demo')
  await mkdir(join(course, 'sources'), { recursive: true })
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage()
  page.drawText('SM-2 keeps the ease factor clamped between 1.3 and 2.9.', { x: 72, y: 760, size: 12, font })
  const path = join(course, 'sources', 'lecture.pdf')
  await writeFile(path, await doc.save())
  return path
}

describe('extract PDF 降级链', () => {
  it('auto + MinerU 成功：用 MinerU 产物，引擎归因 mineru', async () => {
    const path = await pdfFixture()
    parseWithMineruMock.mockResolvedValue('# 第一章\n\nSM-2 的 EF 钳制在 [1.3, 2.9]。\n')
    const outcome = await extractTextToMarkdownWithEngine(path, options('auto'))
    expect(outcome.engine).toBe('mineru')
    expect(outcome.text).toContain('EF 钳制')
    expect(parseWithMineruMock).toHaveBeenCalledWith(path, 'basic', 120)
  })

  it('auto + MinerU 失败：静默回落内置 pdf-parse，引擎归因 builtin', async () => {
    const path = await pdfFixture()
    parseWithMineruMock.mockRejectedValue(new MineruErrorMock('timeout', 'MinerU 解析超时'))
    const outcome = await extractTextToMarkdownWithEngine(path, options('auto'))
    expect(outcome.engine).toBe('builtin')
    expect(outcome.text).toContain('SM-2')
  })

  it('mineru（强制）+ 失败：抛 ExtractionError 且带引擎原因（不回落内置）', async () => {
    const path = await pdfFixture()
    parseWithMineruMock.mockRejectedValue(new MineruErrorMock('nonzero-exit', 'MinerU 解析失败: boom'))
    await expect(extractTextToMarkdown(path, options('mineru'))).rejects.toThrow(ExtractionError)
    await expect(extractTextToMarkdown(path, options('mineru'))).rejects.toThrow(/nonzero-exit/)
  })

  it('builtin：不调用 MinerU', async () => {
    const path = await pdfFixture()
    const outcome = await extractTextToMarkdownWithEngine(path, options('builtin'))
    expect(outcome.engine).toBe('builtin')
    expect(parseWithMineruMock).not.toHaveBeenCalled()
  })

  it('parse=null：完全维持内置行为', async () => {
    const path = await pdfFixture()
    const text = await extractTextToMarkdown(path, null)
    expect(text).toContain('SM-2')
    expect(parseWithMineruMock).not.toHaveBeenCalled()
  })

  it('standard 档位透传给 MinerU', async () => {
    const path = await pdfFixture()
    parseWithMineruMock.mockResolvedValue('# 标准解析产物\n')
    await extractTextToMarkdown(path, options('auto', 'standard'))
    expect(parseWithMineruMock).toHaveBeenCalledWith(path, 'standard', 120)
  })
})
