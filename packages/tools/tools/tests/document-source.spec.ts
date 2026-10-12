import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handlerReadSource, handlerSearchSources, type ToolActions } from '../src/handlers.ts'
import { ToolResult } from '../src/result.ts'
import { MAX_SOURCE_TEXT_CHARS } from '../src/specs.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('passes a full relevant section beyond 4000 characters to the model, including its last line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-source-section-')); roots.push(root)
  const lines = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：${'完整证据'.repeat(20)}`)
  lines[199] = 'SECTION-END-CANARY'
  await writeFile(join(root, 'section.md'), lines.join('\n'))
  const [summary, data] = await handlerReadSource({ courseDir: root, workspaceRoot: root }, { path: 'section.md' })
  expect(data).toMatchObject({ startLine: 1, endLine: 200, truncated: false, nextLine: null })
  const message = new ToolResult('success', summary, data).toToolMessage()
  expect(message.length).toBeGreaterThan(4000)
  expect(message).toContain('200: SECTION-END-CANARY')
  expect(message).not.toContain('内容超预算已截断')
})

it('reports the actually returned line range and resumes without skipping text at the character budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-source-window-')); roots.push(root)
  const lines = Array.from({ length: 200 }, (_, i) => `ROW-${i + 1}-${'x'.repeat(400)}`)
  await writeFile(join(root, 'long.md'), lines.join('\n'))
  const [summary, first] = await handlerReadSource({ courseDir: root, workspaceRoot: root }, { path: 'long.md' })
  const returned = first['lines'] as Array<{ n: number; text: string }>
  const end = first['endLine'] as number
  expect(end).toBeGreaterThan(1)
  expect(end).toBeLessThan(200)
  expect(first).toMatchObject({ truncated: true, partialLine: false, nextLine: end + 1 })
  expect(summary).toContain(`1-${end} 行`)
  const message = new ToolResult('success', summary, first).toToolMessage()
  expect(message).toContain(`${end}: ${lines[end - 1]}`)
  expect(message).toContain(`下一段起始行: ${end + 1}`)
  expect(message).not.toContain('内容超预算已截断')
  const [, second] = await handlerReadSource({ courseDir: root, workspaceRoot: root }, { path: 'long.md', startLine: first['nextLine'] })
  expect((second['lines'] as Array<{ n: number; text: string }>)[0]).toEqual({ n: end + 1, text: lines[end] })
  expect(returned).toHaveLength(end)
})

it('marks a single oversized line explicitly instead of suggesting an endlessly repeated next line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-source-longline-')); roots.push(root)
  await writeFile(join(root, 'one.md'), 'x'.repeat(MAX_SOURCE_TEXT_CHARS + 100))
  const [summary, data] = await handlerReadSource({ courseDir: root, workspaceRoot: root }, { path: 'one.md' })
  expect(data).toMatchObject({ truncated: true, partialLine: true, nextLine: null })
  expect(summary).toContain('该行过长，仅展示开头')
})
it('reads and searches rich document text through the Host extractor after path validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-document-source-'))
  roots.push(root)
  await mkdir(join(root, 'sources'))
  const pdf = join(root, 'sources', 'survey.pdf')
  await writeFile(pdf, Buffer.alloc(300_000))
  const extractSourceText = vi.fn(async () => 'Title\nMemory has three orthogonal axes.\nDetails')
  const ctx = { courseDir: root, workspaceRoot: root, actions: { extractSourceText } as unknown as ToolActions }
  const [, found] = await handlerSearchSources(ctx, { query: 'orthogonal' })
  expect(found['filesScanned']).toBe(1)
  expect(found['matches']).toEqual([{ file: 'sources/survey.pdf', line: 2, text: 'Memory has three orthogonal axes.' }])
  const [, read] = await handlerReadSource(ctx, { path: 'sources/survey.pdf', startLine: 2, endLine: 2 })
  expect(read['lines']).toEqual([{ n: 2, text: 'Memory has three orthogonal axes.' }])
  expect(extractSourceText).toHaveBeenCalledWith(pdf)
  await expect(handlerReadSource(ctx, { path: '../outside.pdf' })).rejects.toThrow()
  expect(extractSourceText).toHaveBeenCalledTimes(2)
})
