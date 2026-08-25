/**
 * 文档摄取测试（对齐 Python `test_pdf_ingestor.py`）：有效 PDF/DOCX/XLSX/HTML
 * 抽取文本 → MarkdownIngestor 双层大纲与切片（无乱码、line_range 合法）；
 * 空白/扫描型/损坏 PDF 抛 ExtractionError（降级不崩溃）；构建器按扩展名分发，
 * 增量 build 对未变文档幂等（零出题调用），降级文件指纹落盘后不重试。
 */

import { writeFile, mkdir, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import ExcelJS from 'exceljs'
import { CourseBuilder, extractTextToMarkdown, ExtractionError } from '../src/index.ts'
import type { HarnessTask, IngestArtifact } from '../src/models.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tmpDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-extract-'))
  tmpRoots.push(root)
  return root
}

async function makeCourse(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-extract-'))
  tmpRoots.push(root)
  const course = join(root, 'demo')
  await mkdir(join(course, 'sources'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(course, 'sources', name), content)
  }
  return course
}

class FakeGenerator implements TaskGenerator {
  calls = 0
  async generateTasks(chunk: IngestArtifact['chunks'][number], count: number): Promise<HarnessTask[]> {
    this.calls += 1
    return Array.from({ length: count }, (_, index) => ({
      task_id: `${chunk.concept_id.replace(/^c_/, '')}_00${index + 1}`,
      concept_id: chunk.concept_id,
      source_ref: chunk.source_ref,
      type: 'concept',
      difficulty: 2,
      question: `关于「${chunk.title}」的问题 ${index + 1}`,
      options: null,
      evaluation_criteria: { rubric: ['要点一', '要点二'], keywords: [chunk.title] },
      history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
      deprecated: false,
      dynamic: false,
      target_id: null,
    }))
  }
}

// ---------------------------------------------------------------------------
// 夹具生成（纯 JS，无外部二进制）
// ---------------------------------------------------------------------------

async function writePdf(path: string, lines: string[], pages = 1): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage()
    let y = 760
    for (const line of lines) {
      page.drawText(line, { x: 72, y, size: 14, font })
      y -= 22
    }
  }
  await writeFile(path, await doc.save())
}

async function writeDocx(path: string, heading: string, body: string): Promise<void> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(heading)] }),
        new Paragraph(body),
      ],
    }],
  })
  await writeFile(path, await Packer.toBuffer(doc))
}

async function writeXlsx(path: string, rows: string[][]): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const row of rows) ws.addRow(row)
  await wb.xlsx.writeFile(path)
}

// ---------------------------------------------------------------------------
// 抽取单元：有效文档
// ---------------------------------------------------------------------------

describe('extractTextToMarkdown', () => {
  it('PDF 抽取可读文本（无乱码）', async () => {
    const root = await tmpDir()
    const pdf = join(root, 'guide.pdf')
    await writePdf(pdf, ['Chapter 1 Scheduling', '', 'Filter eliminates nodes first.'])
    const text = await extractTextToMarkdown(pdf)
    expect(text).toContain('Scheduling')
    expect(text).toContain('Filter')
  })

  it('DOCX 抽取走 mammoth → markdown', async () => {
    const root = await tmpDir()
    const docx = join(root, 'guide.docx')
    await writeDocx(docx, 'Chapter 2 Docx', 'Mammoth paragraph content.')
    const text = await extractTextToMarkdown(docx)
    expect(text).toContain('# Chapter 2 Docx')
    expect(text).toContain('Mammoth paragraph content.')
  })

  it('XLSX 抽取为 sheet 标题 + markdown 表格', async () => {
    const root = await tmpDir()
    const xlsx = join(root, 'guide.xlsx')
    await writeXlsx(xlsx, [['Name', 'Value'], ['Alpha', 42]])
    const text = await extractTextToMarkdown(xlsx)
    expect(text).toContain('## Sheet1')
    expect(text).toContain('| Name |')
    expect(text).toContain('Alpha')
  })

  it('HTML 抽取经 turndown 转 markdown', async () => {
    const root = await tmpDir()
    const html = join(root, 'guide.html')
    await writeFile(html, '<html><body><h1>Chapter 3 HTML</h1><p>Html paragraph.</p></body></html>')
    const text = await extractTextToMarkdown(html)
    expect(text).toContain('# Chapter 3 HTML')
    expect(text).toContain('Html paragraph.')
  })
})

// ---------------------------------------------------------------------------
// 抽取单元：降级抛错（对齐 Python PdfExtractionError 语义）
// ---------------------------------------------------------------------------

describe('extractTextToMarkdown degraded', () => {
  it('空白 PDF（无文本层）抛 ExtractionError', async () => {
    const root = await tmpDir()
    const pdf = join(root, 'blank.pdf')
    await writePdf(pdf, [])
    await expect(extractTextToMarkdown(pdf)).rejects.toBeInstanceOf(ExtractionError)
  })

  it('扫描型 PDF（多页纯图片无文本）抛 ExtractionError', async () => {
    const root = await tmpDir()
    const pdf = join(root, 'scanned.pdf')
    await writePdf(pdf, [], 3)
    await expect(extractTextToMarkdown(pdf)).rejects.toBeInstanceOf(ExtractionError)
  })

  it('损坏 PDF 抛 ExtractionError 不崩溃', async () => {
    const root = await tmpDir()
    const pdf = join(root, 'broken.pdf')
    await writeFile(pdf, Buffer.from('%PDF-1.4 garbage not a real pdf .... '))
    await expect(extractTextToMarkdown(pdf)).rejects.toBeInstanceOf(ExtractionError)
  })
})

// ---------------------------------------------------------------------------
// 构建器集成（对齐 Python test_builder_* 用例）
// ---------------------------------------------------------------------------

describe('CourseBuilder with extracted documents', () => {
  it('PDF 参与构建：切片/大纲/出题，二次 build 幂等', async () => {
    const course = await makeCourse({})
    const pdf = join(course, 'sources', 'guide.pdf')
    await writePdf(pdf, ['# Scheduling Basics', '', '## Filter and Score', '', 'Filter eliminates nodes.', '', '## Preemption', '', 'Higher priority preempts lower priority.'])
    const gen = new FakeGenerator()
    const builder = new CourseBuilder(course, gen)

    const report = await builder.build()
    expect(report.added).toEqual(['guide.pdf'])
    expect(report.degraded).toEqual([])
    expect(report.tasksGenerated).toBe(4)
    expect(gen.calls).toBe(2)

    const syllabus = JSON.parse(await readFile(join(course, 'syllabus.json'), 'utf8'))
    const conceptNames = syllabus.chapters.flatMap((ch: { concepts: { name: string }[] }) => ch.concepts.map((c: { name: string }) => c.name))
    expect(conceptNames).toEqual(['Filter and Score', 'Preemption'])

    // 幂等：第二次 build 零出题调用、指纹表含 pdf
    const callsBefore = gen.calls
    const report2 = await builder.build()
    expect(report2.added).toEqual([])
    expect(report2.unchanged).toEqual(['guide.pdf'])
    expect(gen.calls).toBe(callsBefore)
    const checksums = JSON.parse(await readFile(join(course, 'sources', '.checksums'), 'utf8'))
    expect(Object.keys(checksums)).toEqual(['guide.pdf'])
  })

  it('坏 PDF 降级但好 md 正常处理，降级文件指纹落盘后不重试', async () => {
    const goodMd = '# Networking Basics\n\n## CNI\n\nCalico uses BGP to distribute routes.'
    const course = await makeCourse({
      'broken.pdf': Buffer.from('%PDF fake'),
      'good.md': goodMd,
    })
    const gen = new FakeGenerator()
    const builder = new CourseBuilder(course, gen)

    const report = await builder.build()
    expect(report.degraded).toEqual(['broken.pdf'])
    expect([...report.added].sort()).toEqual(['broken.pdf', 'good.md'])
    expect(report.tasksGenerated).toBe(2)
    expect(gen.calls).toBe(1)
    expect(await readFile(join(course, 'syllabus.json'), 'utf8')).toContain('CNI')

    const callsBefore = gen.calls
    const report2 = await builder.build()
    expect(report2.added).toEqual([])
    expect(report2.unchanged.sort()).toEqual(['broken.pdf', 'good.md'])
    expect(gen.calls).toBe(callsBefore)
    expect(report2.degraded).toEqual([])
  })

  it('DOCX/XLSX/HTML 混排构建一并进行大纲与出题', async () => {
    const course = await makeCourse({})
    await writeDocx(join(course, 'sources', 'note.docx'), 'Docx Chapter', 'Docx body text.')
    await writeXlsx(join(course, 'sources', 'metrics.xlsx'), [['Metric', 'Target'], ['Availability', 99.9]])
    await writeFile(join(course, 'sources', 'manual.html'), '<html><body><h1>Html Chapter</h1><p>Html body text.</p></body></html>')
    const gen = new FakeGenerator()
    const builder = new CourseBuilder(course, gen)

    const report = await builder.build()
    expect(report.degraded).toEqual([])
    expect(report.added.sort()).toEqual(['manual.html', 'metrics.xlsx', 'note.docx'])
    expect(gen.calls).toBe(3)
    const syllabus = JSON.parse(await readFile(join(course, 'syllabus.json'), 'utf8'))
    const concepts = syllabus.chapters.flatMap((ch: { concepts: { name: string }[] }) => ch.concepts.map((c: { name: string }) => c.name))
    expect(concepts.sort()).toEqual(['Docx Chapter', 'Html Chapter', 'Sheet1'])
  })
})
