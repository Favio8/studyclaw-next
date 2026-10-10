/**
 * parsed/ 缓存（PRD 需求一 F1.5）：内容寻址文件名、manifest 失效判定、
 * 读写与损坏兜底；以及 CourseBuilder 集成——引擎/档位变更触发重解析、
 * 切回旧档位命中内容寻址缓存、auto 回落 builtin 后下次构建重试 MinerU。
 */

import { mkdir, writeFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const { parseWithMineruMock } = vi.hoisted(() => ({ parseWithMineruMock: vi.fn() }))
vi.mock('../src/mineru.ts', () => ({ parseWithMineru: parseWithMineruMock }))

import {
  CourseBuilder,
  loadParsedManifest,
  parsedEntryStale,
  parsedFileName,
  readParsedText,
  saveParsedManifest,
  writeParsedText,
} from '../src/index.ts'
import type { ParseEngineOptions } from '../src/mineru.ts'
import type { HarnessTask, IngestArtifact } from '../src/models.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  parseWithMineruMock.mockReset()
})

function options(engine: ParseEngineOptions['engine'], tier: ParseEngineOptions['tier'] = 'basic'): ParseEngineOptions {
  return { engine, tier, timeoutSec: 120, concurrency: 1 }
}

class FakeGenerator {
  calls = 0
  async generateTasks(chunk: IngestArtifact['chunks'][number], count: number): Promise<HarnessTask[]> {
    this.calls += 1
    return Array.from({ length: count }, (_, index) => ({
      task_id: `${chunk.concept_id.replace(/^c_/, '')}_00${index + 1}`,
      concept_id: chunk.concept_id,
      source_ref: chunk.source_ref,
      type: 'concept' as const,
      difficulty: 2,
      question: `关于「${chunk.title}」的问题 ${index + 1}`,
      options: null,
      evaluation_criteria: { rubric: ['要点一'], keywords: [chunk.title] },
      history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, ef: 2.5 },
      deprecated: false,
      dynamic: false,
      target_id: null,
    }))
  }
}

async function courseWithPdf(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-parsed-'))
  tmpRoots.push(root)
  const courseDir = join(root, 'demo')
  await mkdir(join(courseDir, 'sources'), { recursive: true })
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage()
  page.drawText('Ease factor is clamped to the range 1.3 to 2.9 in SM-2.', { x: 72, y: 760, size: 12, font })
  await writeFile(join(courseDir, 'sources', 'lecture.pdf'), await doc.save())
  return courseDir
}

describe('parsed-cache 单元', () => {
  it('parsedFileName 内容寻址：同 sha 同档位稳定，剥 sha256: 前缀', () => {
    expect(parsedFileName('sha256:abc123def456', 'basic')).toBe('abc123def456-basic.md')
    expect(parsedFileName('abc123def456', 'standard')).toBe('abc123def456-standard.md')
  })

  it('parsedEntryStale：sha/engine/tier 任一不一致即失效；缺失即失效', () => {
    const entry = { sha256: 's1', engine: 'mineru' as const, tier: 'basic', out: 'x.md' }
    expect(parsedEntryStale(entry, 's1', 'mineru', 'basic')).toBe(false)
    expect(parsedEntryStale(entry, 's2', 'mineru', 'basic')).toBe(true)
    expect(parsedEntryStale(entry, 's1', 'builtin', 'basic')).toBe(true)
    expect(parsedEntryStale(entry, 's1', 'mineru', 'standard')).toBe(true)
    expect(parsedEntryStale(undefined, 's1', 'mineru', 'basic')).toBe(true)
  })

  it('manifest 读写往返；损坏 JSON 视为空（不抛错）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-manifest-'))
    tmpRoots.push(root)
    const stateDir = join(root, '.studyclaw')
    await mkdir(stateDir, { recursive: true })
    await saveParsedManifest(stateDir, { 'a.pdf': { sha256: 's1', engine: 'mineru', tier: 'basic', out: 'f.md' } })
    expect(await loadParsedManifest(stateDir)).toEqual({ 'a.pdf': { sha256: 's1', engine: 'mineru', tier: 'basic', out: 'f.md' } })
    await writeFile(join(stateDir, 'parsed', 'manifest.json'), '{ 坏 JSON', 'utf8')
    expect(await loadParsedManifest(stateDir)).toEqual({})
  })

  it('readParsedText 缺失返回 null；写入后可读回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-parsedtext-'))
    tmpRoots.push(root)
    const stateDir = join(root, '.studyclaw')
    expect(await readParsedText(stateDir, 'x.md')).toBeNull()
    await writeParsedText(stateDir, 'x.md', '# 内容\n')
    expect(await readParsedText(stateDir, 'x.md')).toContain('内容')
  })
})

describe('CourseBuilder × MinerU 缓存', () => {
  it('首建：MinerU 产物落盘 + manifest 记 mineru', async () => {
    const courseDir = await courseWithPdf()
    parseWithMineruMock.mockResolvedValue('# 第一章\n\nEase factor 钳制在 [1.3, 2.9]。\n')
    const builder = new CourseBuilder(courseDir, new FakeGenerator(), null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('auto'))
    const report = await builder.build(1)
    expect(report.degraded).not.toContain('sources/lecture.pdf')
    expect(parseWithMineruMock).toHaveBeenCalledTimes(1)
    const manifest = await loadParsedManifest(join(courseDir, '.studyclaw'))
    const entry = Object.values(manifest)[0]
    expect(entry?.engine).toBe('mineru')
    expect(entry?.tier).toBe('basic')
    expect(entry?.out).toMatch(/-basic\.md$/)
    expect(await readParsedText(join(courseDir, '.studyclaw'), entry!.out!)).toContain('钳制')
  })

  it('二次构建无变更：不重复调用 MinerU（checksum 增量 + manifest 一致）', async () => {
    const courseDir = await courseWithPdf()
    parseWithMineruMock.mockResolvedValue('# 第一章\n\nEase factor 钳制在 [1.3, 2.9]。\n')
    const make = () => new CourseBuilder(courseDir, new FakeGenerator(), null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('auto'))
    await make().build(1)
    await make().build(1)
    expect(parseWithMineruMock).toHaveBeenCalledTimes(1)
  })

  it('档位切换：basic→standard 重解析；切回 basic 命中内容寻址缓存（零调用）', async () => {
    const courseDir = await courseWithPdf()
    parseWithMineruMock.mockResolvedValue('# 产物\n\n正文。\n')
    const make = (tier: 'basic' | 'standard') =>
      new CourseBuilder(courseDir, new FakeGenerator(), null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('auto', tier))
    await make('basic').build(1)
    expect(parseWithMineruMock).toHaveBeenCalledTimes(1)
    // 切到 standard：manifest 档位不一致 → 重新抽取
    await make('standard').build(1)
    expect(parseWithMineruMock).toHaveBeenCalledTimes(2)
    const manifest = await loadParsedManifest(join(courseDir, '.studyclaw'))
    expect(Object.values(manifest)[0]?.tier).toBe('standard')
    // 切回 basic：内容寻址文件还在 → 缓存命中，不再起进程
    await make('basic').build(1)
    expect(parseWithMineruMock).toHaveBeenCalledTimes(2)
  })

  it('auto 回落：MinerU 失败用内置解析并记 builtin，下次构建重试 MinerU', async () => {
    const courseDir = await courseWithPdf()
    parseWithMineruMock.mockRejectedValueOnce(new Error('boom'))
    const make = () => new CourseBuilder(courseDir, new FakeGenerator(), null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('auto'))
    const first = await make().build(1)
    expect(first.degraded).not.toContain('sources/lecture.pdf') // 内置解析成功，文件本身不进 degraded
    let manifest = await loadParsedManifest(join(courseDir, '.studyclaw'))
    expect(Object.values(manifest)[0]?.engine).toBe('builtin')
    expect(Object.values(manifest)[0]?.out).toBeNull()
    // MinerU 恢复后：manifest builtin ≠ mineru → 重试并改写归因
    parseWithMineruMock.mockResolvedValue('# MinerU 恢复\n\n正文。\n')
    await make().build(1)
    expect(parseWithMineruMock).toHaveBeenCalledTimes(2)
    manifest = await loadParsedManifest(join(courseDir, '.studyclaw'))
    expect(Object.values(manifest)[0]?.engine).toBe('mineru')
  })

  it('engine=builtin：不写 manifest、不调用 MinerU', async () => {
    const courseDir = await courseWithPdf()
    const builder = new CourseBuilder(courseDir, new FakeGenerator(), null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('builtin'))
    const report = await builder.build(1)
    expect(report.degraded).not.toContain('sources/lecture.pdf')
    expect(parseWithMineruMock).not.toHaveBeenCalled()
    const parsedDir = join(courseDir, '.studyclaw', 'parsed')
    await expect(readFile(join(parsedDir, 'manifest.json'), 'utf8')).rejects.toThrow()
  })

  it('LLM 生成阶段抛错：已成功的解析 manifest 仍然落盘（真机验证发现）', async () => {
    const courseDir = await courseWithPdf()
    parseWithMineruMock.mockResolvedValue('# MinerU 产物\n\n正文。\n')
    // generator 在生成阶段炸掉（模拟 LLM 端点不可达）——抽取已成功，
    // manifest 必须已经写盘，不能等 build 收尾才保存。
    const exploding = {
      async generateTasks() {
        throw new Error('ECONNREFUSED：LLM 端点不可达')
      },
    }
    const builder = new CourseBuilder(courseDir, exploding, null, null, 'fine', ['.pdf'], courseDir, join(courseDir, '.studyclaw'), null, false, undefined, options('auto'))
    await expect(builder.build(1)).rejects.toThrow('LLM 端点不可达')
    const manifest = await loadParsedManifest(join(courseDir, '.studyclaw'))
    const entry = Object.values(manifest)[0]
    expect(entry).toMatchObject({ engine: 'mineru', tier: 'basic' })
    expect(await readParsedText(join(courseDir, '.studyclaw'), entry!.out!)).toContain('MinerU 产物')
  })
})
