/**
 * Source text extraction: PDF/DOCX/HTML convert to Markdown through direct
 * libraries (FL-39：pdf-parse / mammoth / turndown 直用，替代 markitdown-ts——
 * 甩掉其传递闭包里的整个 Vercel AI SDK 与 jsdom，约 100MB+ 依赖面). With
 * Python-parity degraded semantics — extraction failure or empty result raises
 * `ExtractionError` so the builder records `degraded` without crashing.
 * Plain `.md`/`.txt` reads as-is so their behavior is unchanged.
 * @module @studyclaw/course-builder/src/extract
 */

import { readFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import TurndownService from 'turndown'
import XLSX from 'xlsx'
import { MineruError, parseWithMineru, type ParseEngineOptions } from './mineru.ts'
// FL-38：SheetJS 0.20.x 的 ESM 构建（xlsx.mjs）不再自动绑定 node:fs——
// 必须用 `set_fs(fs 模块)` 显式注入（内部按 `_fs.readFileSync` 调用），
// 否则 `XLSX.readFile` 抛 "Cannot access file"。
XLSX.set_fs(nodeFs)

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

/** Non-plain-text extensions handed to the structured extractors. */
export const EXTRACTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.html', '.htm'] as const

// Turndown (with domino, a lightweight DOM) is stateless once constructed;
// reuse one instance across files so the converter warms up only once.
let turndown: TurndownService | null = null
function turndownInstance(): TurndownService {
  turndown ??= new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return turndown
}

/**
 * XLSX：直读工作表（FL-38 的 0.20.x + set_fs），逐 sheet 生成
 * `## sheet 名` + markdown 表格（首行为表头）。原 markitdown 路径是
 * sheet→HTML→turndown(gfm)，这里直接产表格——同一输出契约，少一层转换。
 */
async function extractXlsxToMarkdown(sourcePath: string): Promise<string> {
  const workbook = XLSX.readFile(sourcePath)
  const md: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!
    if (!sheet?.['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })
    if (rows.length === 0) continue
    const cells = (row: unknown[]): string => `| ${row.map(cell => String(cell).replaceAll('|', '\\|')).join(' | ')} |`
    md.push([`## ${sheetName}`, '', cells(rows[0]!), `| ${rows[0]!.map(() => '---').join(' | ')} |`, ...rows.slice(1).map(cells)].join('\n'))
  }
  const text = md.join('\n\n').trim()
  if (text === '') {
    throw new ExtractionError(`未提取到可检索文本（空工作表）: ${sourcePath}`)
  }
  return text
}

async function extractPdfToMarkdown(sourcePath: string): Promise<string> {
  const data = await readFile(sourcePath)
  const parser = new PDFParse({ data })
  try {
    return (await parser.getText()).text
  } finally {
    // pdfjs 文档句柄必须显式释放，长跑构建才不累积内存。BUG-002：destroy
    // 同步抛出会穿透 finally 并覆盖 getText 的原始异常——就地吞掉清理错误，
    // 资源交给 GC/进程退出兜底，业务异常照常传播。
    try {
      await parser.destroy()
    } catch {
      // 释放失败不必上抛。
    }
  }
}

/**
 * PDF 解析降级链（PRD 需求一）：
 * - engine=auto：MinerU 启用且可用时优先；任何 MinerU 失败静默回落内置
 *   pdf-parse（用户没点名要 MinerU，builtin 结果就是合格结果）；
 * - engine=mineru（强制）：MinerU 失败即抛 ExtractionError——调用方
 *   （builder）记入 report.degraded，不用 builtin 结果冒充；
 * - engine=builtin：只用内置。
 * 两条路都失败/零文本时抛 ExtractionError，由 builder 记 degraded。
 * 返回实际产出文本的引擎，供 builder 写 manifest（auto 回落记 builtin，
 * 下次构建重试 MinerU）。
 */
async function extractPdfWithFallback(sourcePath: string, parse: ParseEngineOptions | null): Promise<{ text: string; engine: 'mineru' | 'builtin' }> {
  if (parse !== null && parse.engine !== 'builtin') {
    try {
      return { text: await parseWithMineru(sourcePath, parse.tier, parse.timeoutSec), engine: 'mineru' }
    } catch (error) {
      if (parse.engine === 'mineru') {
        if (error instanceof MineruError) {
          throw new ExtractionError(`MinerU 解析失败（${error.code}）: ${error.message}`)
        }
        throw error
      }
      // auto：静默回落 builtin。
    }
  }
  return { text: await extractPdfToMarkdown(sourcePath), engine: 'builtin' }
}

async function extractDocxToMarkdown(sourcePath: string): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ path: sourcePath })
  return turndownInstance().turndown(html ?? '')
}

async function extractHtmlToMarkdown(sourcePath: string): Promise<string> {
  const html = await readFile(sourcePath, 'utf8')
  return turndownInstance().turndown(html)
}

/** 抽取主路径：返回文本与实际产出引擎（auto 回落 builtin 时如实报告）。 */
async function extractToMarkdownOutcome(sourcePath: string, parse: ParseEngineOptions | null): Promise<{ text: string; engine: 'mineru' | 'builtin' }> {
  if (sourcePath.toLowerCase().endsWith('.xlsx')) {
    return { text: await extractXlsxToMarkdown(sourcePath), engine: 'builtin' }
  }
  let outcome: { text: string; engine: 'mineru' | 'builtin' }
  try {
    if (sourcePath.toLowerCase().endsWith('.pdf')) {
      outcome = await extractPdfWithFallback(sourcePath, parse)
    } else if (sourcePath.toLowerCase().endsWith('.docx')) {
      outcome = { text: await extractDocxToMarkdown(sourcePath), engine: 'builtin' }
    } else {
      outcome = { text: await extractHtmlToMarkdown(sourcePath), engine: 'builtin' }
    }
  } catch (error) {
    if (error instanceof ExtractionError) throw error
    throw new ExtractionError(`文档解析失败（可能损坏或加密）: ${error instanceof Error ? error.message : String(error)}`)
  }
  // pdf-parse 默认在每页后追加 "-- N of M --" 页界标记（Python pypdf 输出
  // 本无此标记），对大纲/切片是无意义噪音，净化后再判空。
  const cleaned = outcome.text.replace(/-- \d+ of \d+ --/g, ' ').trim()
  if (cleaned === '') {
    throw new ExtractionError(`未提取到可检索文本（扫描件/图片型文档）: ${sourcePath}`)
  }
  return { text: cleaned, engine: outcome.engine }
}

/** PDF/Office/HTML → Markdown 文本；失败或零文本抛 ExtractionError（降级用）。
 *  `parse` 为 null 时完全维持内置行为（pdf-parse 直用）。 */
export async function extractTextToMarkdown(sourcePath: string, parse: ParseEngineOptions | null = null): Promise<string> {
  return (await extractToMarkdownOutcome(sourcePath, parse)).text
}

/** 同 extractTextToMarkdown，但如实返回实际产出文本的引擎（manifest 归因用：
 *  auto 模式下 MinerU 失败回落 builtin 时报告 builtin，下次构建重试 MinerU）。 */
export async function extractTextToMarkdownWithEngine(sourcePath: string, parse: ParseEngineOptions | null = null): Promise<{ text: string; engine: 'mineru' | 'builtin' }> {
  return extractToMarkdownOutcome(sourcePath, parse)
}

/** 与 Python `extract_pdf_text` 对齐：md/txt 原样读取，其余走结构化抽取。 */
export async function extractSourceText(sourcePath: string, extension: string, parse: ParseEngineOptions | null = null): Promise<string> {
  if (extension === '.md' || extension === '.txt') {
    return readFile(sourcePath, 'utf8')
  }
  return extractTextToMarkdown(sourcePath, parse)
}
