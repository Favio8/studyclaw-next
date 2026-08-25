/**
 * Source text extraction: PDF/Office/HTML convert to Markdown through
 * markitdown-ts (MIT, TS port of Microsoft MarkItDown), with Python-parity
 * degraded semantics — extraction failure or empty result raises
 * `ExtractionError` so the builder records `degraded` without crashing.
 * Plain `.md`/`.txt` reads as-is so their behavior is unchanged.
 * @module @studyclaw/course-builder/src/extract
 */

import { readFile } from 'node:fs/promises'
import { MarkItDown } from 'markitdown-ts'
import XLSX from 'xlsx'

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

/** Non-plain-text extensions handed to markitdown-ts. */
export const EXTRACTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.html', '.htm'] as const

// Converter registry is read-only after construction; reuse one instance
// across files so pdf-parse/mammoth/xlsx warm up only once.
let markitdown: MarkItDown | null = null
function markitdownInstance(): MarkItDown {
  markitdown ??= new MarkItDown()
  return markitdown
}

/**
 * XLSX: markitdown-ts 内部 `import * as XLSX` 在纯 Node ESM 下拿不到
 * `readFile`（namespace interop 问题），这里用 default import 直读工作表，
 * 转 HTML 后复用同一 HtmlConverter 得到 markdown 表格。
 */
async function extractXlsxToMarkdown(sourcePath: string): Promise<string> {
  const workbook = XLSX.readFile(sourcePath)
  const md: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!
    if (sheet?.['!ref']) {
      const html = XLSX.utils.sheet_to_html(sheet)
      const converted = await markitdownInstance().convertBuffer(Buffer.from(html), { file_extension: '.html' })
      md.push(`## ${sheetName}\n\n${converted?.markdown ?? ''}`)
    }
  }
  const text = md.join('\n\n').trim()
  if (text === '') {
    throw new ExtractionError(`未提取到可检索文本（空工作表）: ${sourcePath}`)
  }
  return text
}

/** PDF/Office/HTML → Markdown 文本；失败或零文本抛 ExtractionError（降级用）。 */
export async function extractTextToMarkdown(sourcePath: string): Promise<string> {
  if (sourcePath.toLowerCase().endsWith('.xlsx')) {
    return extractXlsxToMarkdown(sourcePath)
  }
  const result = await markitdownInstance().convert(sourcePath).catch(error => {
    throw new ExtractionError(`文档解析失败（可能损坏或加密）: ${error instanceof Error ? error.message : String(error)}`)
  })
  // pdf-parse 默认在每页后追加 "-- N of M --" 页界标记（markitdown-ts 未关闭），
  // 对大纲/切片是无意义噪音，净化后再判空（Python pypdf 输出本无此标记）。
  const text = (result?.markdown ?? '').replace(/-- \d+ of \d+ --/g, ' ').trim()
  if (text === '') {
    throw new ExtractionError(`未提取到可检索文本（扫描件/图片型文档）: ${sourcePath}`)
  }
  return text
}

/** 与 Python `extract_pdf_text` 对齐：md/txt 原样读取，其余经 markitdown-ts 转换。 */
export async function extractSourceText(sourcePath: string, extension: string): Promise<string> {
  if (extension === '.md' || extension === '.txt') {
    return readFile(sourcePath, 'utf8')
  }
  return extractTextToMarkdown(sourcePath)
}
