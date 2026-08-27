/**
 * Markdown ingestor: two-level outline slicing (chapter + concept sections),
 * paragraph-boundary chunking with size caps, slug id generation (Chinese
 * falls back to md5 prefix), and concept typing. Ported from Python
 * `ingestor.py::MarkdownIngestor`.
 * @module @studyclaw/course-builder/src/ingestor
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import yaml from 'js-yaml'
import { conceptChunk, ingestArtifact, syllabus, type ConceptChunk, type IngestArtifact, type Syllabus } from './models.ts'

export const DEFAULT_MAX_CHUNK_CHARS = 1800

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const FENCE_RE = /^\s*(```|~~~)/
const ASCII_WORD_RE = /[A-Za-z0-9]+/g

const PRACTICE_KEYWORDS = ['练习', '实践', '实操', '案例', '习题', '实战']
const SCENARIO_KEYWORDS = ['场景', '情景', '故障', '排错', 'debug', '边界', '辨析']

export class IngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestError'
  }
}

interface Heading { level: number; text: string; lineno: number }
interface SectionDraft { title: string; start: number; end: number }

function extractFrontmatter(lines: string[]): [Record<string, unknown>, number] {
  if (lines.length === 0 || lines[0]!.trim() !== '---') return [{}, 1]
  for (let idx = 1; idx < lines.length; idx += 1) {
    const trimmed = lines[idx]!.trim()
    if (trimmed === '---' || trimmed === '...') {
      let meta: unknown = {}
      try {
        meta = yaml.load(lines.slice(1, idx).join('\n')) ?? {}
      } catch {
        meta = {}
      }
      if (typeof meta !== 'object' || meta === null) meta = {}
      return [meta as Record<string, unknown>, idx + 2]
    }
  }
  return [{}, 1]
}

function scanHeadings(lines: string[], bodyStart: number): Heading[] {
  const headings: Heading[] = []
  let inFence = false
  for (let lineno = bodyStart; lineno <= lines.length; lineno += 1) {
    const line = lines[lineno - 1]!
    if (FENCE_RE.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const match = HEADING_RE.exec(line)
    if (match !== null) headings.push({ level: match[1]!.length, text: match[2]!.trim(), lineno })
  }
  return headings
}

/** Idempotent slug; non-ASCII falls back to an md5 prefix (Python parity). */
export function slug(text: string, prefix: string, seen: Set<string>): string {
  const words = text.match(ASCII_WORD_RE) ?? []
  let base = words.map(word => word.toLowerCase()).join('_').slice(0, 40).replace(/^_+|_+$/g, '')
  if (base === '') base = createHash('md5').update(text, 'utf8').digest('hex').slice(0, 8)
  let nodeId = `${prefix}${base}`
  let suffix = 2
  while (seen.has(nodeId)) {
    nodeId = `${prefix}${base}_${suffix}`
    suffix += 1
  }
  seen.add(nodeId)
  return nodeId
}

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/
/**
 * 文档级中文密度门槛：低于该值视为纯西文文档，标签吸收逻辑整体禁用，
 * 保证纯英文课程（哪怕从 PDF 转换）的结构完全不被误伤。
 */
const MIN_DOC_CJK_CHARS = 10

function countCjk(text: string): number {
  return (text.match(new RegExp(CJK_CHAR_RE.source, 'g')) ?? []).length
}

/** Whether any BODY line of the section (below its own heading) contains CJK. */
function rangeHasCjk(lines: string[], section: SectionDraft): boolean {
  for (let lineno = section.start + 1; lineno <= section.end; lineno += 1) {
    if (CJK_CHAR_RE.test(lines[lineno - 1] ?? '')) return true
  }
  return false
}

export function conceptTypeOf(title: string): 'practice' | 'scenario' | 'mechanism' {
  if (PRACTICE_KEYWORDS.some(keyword => title.includes(keyword))) return 'practice'
  if (SCENARIO_KEYWORDS.some(keyword => title.toLowerCase().includes(keyword.toLowerCase()))) return 'scenario'
  return 'mechanism'
}

function splitParagraphs(lines: string[], start: number, end: number): Array<[number, number, string]> {
  const paragraphs: Array<[number, number, string]> = []
  let curStart = 0
  const curLines: string[] = []
  for (let lineno = start; lineno <= end; lineno += 1) {
    const line = lines[lineno - 1]!
    if (line.trim() !== '') {
      if (curLines.length === 0) curStart = lineno
      curLines.push(line)
    } else if (curLines.length > 0) {
      paragraphs.push([curStart, lineno - 1, curLines.join('\n')])
      curLines.length = 0
    }
  }
  if (curLines.length > 0) paragraphs.push([curStart, end, curLines.join('\n')])
  return paragraphs
}

function isHeadingLine(lines: string[], lineno: number): boolean {
  if (lineno < 1 || lineno > lines.length) return false
  return HEADING_RE.test(lines[lineno - 1]!)
}

/**
 * CJK Radical (Kangxi Radicals U+2F00–U+2FD5) → visually identical CJK
 * Unified Ideograph, written as the CANONICAL 214-radical sequence
 * (U+2F00 + N-1 = radical N). PDF font encodings frequently re-encode
 * ordinary characters to these radical code points (observed in real
 * lecture PDFs: 「行」 lands on U+2F8F), so an entry is chosen for every
 * radical whose glyph matches a modern (simplified-leaning) ideograph;
 * partial/component-only shapes are omitted.
 *
 * Historical note: an earlier hand-written table drifted off the official
 * sequence (e.g. U+2F8F mapped to 「襾」 instead of 「行」, turning
 * 「运行轨迹」into garbage). Kept entries below follow the Unicode order
 * one-to-one; only radicals whose standalone form exists in modern use are
 * listed. U+2FB0–U+2FD5 retain the legacy tail (rarely observed in corpora).
 *
 * CJK Radicals Supplement (U+2E80–U+2EF3) additions are semantic-only,
 * driven by observed real-world documents (常⻅→常见 / 按⻆⾊→角色 /
 * ⻓期→长期 / ⻛险→风险).
 */
const RADICAL_TO_IDEOGRAPH: Record<string, string> = {
  // CJK Radicals Supplement — targeted additions (observed in real PDFs)
  '\u2EC5': '见', '\u2EC6': '角', '\u2ED3': '长', '\u2EDB': '风',
  // Kangxi 1–20
  '\u2F00': '一', '\u2F01': '丨', '\u2F02': '丶', '\u2F03': '丿',
  '\u2F04': '乙', '\u2F05': '亅', '\u2F06': '二', '\u2F07': '亠',
  '\u2F08': '人', '\u2F09': '儿', '\u2F0A': '入', '\u2F0B': '八',
  '\u2F0C': '冂', '\u2F0D': '冖', '\u2F0E': '冫', '\u2F0F': '几',
  '\u2F10': '凵', '\u2F11': '刀', '\u2F12': '力', '\u2F13': '勹',
  '\u2F14': '匕', '\u2F15': '匚', '\u2F16': '匸', '\u2F17': '十',
  '\u2F18': '卜', '\u2F19': '卩', '\u2F1A': '厂', '\u2F1B': '厶',
  '\u2F1C': '又',
  // Kangxi 30–63
  '\u2F1D': '口', '\u2F1E': '囗', '\u2F1F': '土', '\u2F20': '士',
  '\u2F21': '夂', '\u2F22': '夊', '\u2F23': '夕', '\u2F24': '大',
  '\u2F25': '女', '\u2F26': '子', '\u2F27': '宀', '\u2F28': '寸',
  '\u2F29': '小', '\u2F2A': '尢', '\u2F2B': '尸', '\u2F2C': '屮',
  '\u2F2D': '山', '\u2F2E': '巛', '\u2F2F': '工', '\u2F30': '己',
  '\u2F31': '巾', '\u2F32': '干', '\u2F33': '幺', '\u2F34': '广',
  '\u2F35': '廴', '\u2F36': '廾', '\u2F37': '弋', '\u2F38': '弓',
  '\u2F39': '彐', '\u2F3A': '彡', '\u2F3B': '彳', '\u2F3C': '心',
  '\u2F3D': '戈', '\u2F3E': '户', '\u2F3F': '手', '\u2F40': '支',
  // Kangxi 66–105
  '\u2F41': '攴', '\u2F42': '文', '\u2F43': '斗', '\u2F44': '斤',
  '\u2F45': '方', '\u2F46': '无', '\u2F47': '日', '\u2F48': '曰',
  '\u2F49': '月', '\u2F4A': '木', '\u2F4B': '欠', '\u2F4C': '止',
  '\u2F4D': '歹', '\u2F4E': '殳', '\u2F4F': '毋', '\u2F50': '比',
  '\u2F51': '毛', '\u2F52': '氏', '\u2F53': '气', '\u2F54': '水',
  '\u2F55': '火', '\u2F56': '爪', '\u2F57': '父', '\u2F58': '爻',
  '\u2F59': '爿', '\u2F5A': '片', '\u2F5B': '牙', '\u2F5C': '牛',
  '\u2F5D': '犬', '\u2F5E': '玄', '\u2F5F': '玉', '\u2F60': '瓜',
  '\u2F61': '瓦', '\u2F62': '甘', '\u2F63': '生', '\u2F64': '用',
  '\u2F65': '田', '\u2F66': '疋', '\u2F67': '疒', '\u2F68': '癶',
  '\u2F69': '白',
  // Kangxi 107–176
  '\u2F6A': '皮', '\u2F6B': '皿', '\u2F6C': '目', '\u2F6D': '矛',
  '\u2F6E': '矢', '\u2F6F': '石', '\u2F70': '示', '\u2F71': '禸',
  '\u2F72': '禾', '\u2F73': '穴', '\u2F74': '立', '\u2F75': '竹',
  '\u2F76': '米', '\u2F77': '糸', '\u2F78': '缶', '\u2F79': '网',
  '\u2F7A': '羊', '\u2F7B': '羽', '\u2F7C': '老', '\u2F7D': '而',
  '\u2F7E': '耒', '\u2F7F': '耳', '\u2F80': '聿', '\u2F81': '肉',
  '\u2F82': '臣', '\u2F83': '自', '\u2F84': '至', '\u2F85': '臼',
  '\u2F86': '舌', '\u2F87': '舛', '\u2F88': '舟', '\u2F89': '艮',
  '\u2F8A': '色', '\u2F8B': '艸', '\u2F8C': '虍', '\u2F8D': '虫',
  '\u2F8E': '血', '\u2F8F': '行', '\u2F90': '襾', '\u2F91': '见',
  '\u2F92': '角', '\u2F93': '言', '\u2F94': '谷', '\u2F95': '豆',
  '\u2F96': '豕', '\u2F97': '豸', '\u2F98': '贝', '\u2F99': '赤',
  '\u2F9A': '走', '\u2F9B': '足', '\u2F9C': '身', '\u2F9D': '车',
  '\u2F9E': '辛', '\u2F9F': '辰', '\u2FA0': '辵', '\u2FA1': '邑',
  '\u2FA2': '酉', '\u2FA3': '釆', '\u2FA4': '里', '\u2FA5': '金',
  '\u2FA6': '长', '\u2FA7': '门', '\u2FA8': '阜', '\u2FA9': '隶',
  '\u2FAA': '隹', '\u2FAB': '雨', '\u2FAC': '靑', '\u2FAD': '非',
  '\u2FAE': '面', '\u2FAF': '革',
  // U+2FB0–U+2FD5 — legacy tail kept from the previous table
  '\u2FB0': '韦', '\u2FB1': '韭', '\u2FB2': '音', '\u2FB3': '页',
  '\u2FB4': '风', '\u2FB5': '飞', '\u2FB6': '食', '\u2FB7': '首',
  '\u2FB8': '香', '\u2FB9': '马', '\u2FBA': '骨', '\u2FBB': '高',
  '\u2FBC': '髟', '\u2FBD': '斗', '\u2FBE': '鱼', '\u2FBF': '鸟',
  '\u2FC0': '鹿', '\u2FC1': '麦', '\u2FC2': '麻', '\u2FC3': '黄',
  '\u2FC4': '黍', '\u2FC5': '黑', '\u2FC6': '黹', '\u2FC7': '黾',
  '\u2FC8': '鼎', '\u2FC9': '鼓', '\u2FCA': '鼠', '\u2FCB': '鼻',
  '\u2FCC': '齐', '\u2FCD': '齿', '\u2FCE': '龙', '\u2FCF': '龟',
  '\u2FD0': '仑', '\u2FD1': '伞', '\u2FD2': '金', '\u2FD3': '长',
  '\u2FD4': '门', '\u2FD5': '隶',
}

/**
 * Pure-ASCII short label heuristic for label-shaped SECTIONS extracted from
 * flattened PDFs. When the surrounding document is CJK-rich but a section
 * headed by such a label contains zero CJK (e.g. shell comment headers of
 * curl demos — `# Response`, `# Chat Completions` — inside a Chinese lecture),
 * it is conversion noise rather than a knowledge point, and gets absorbed
 * into its predecessor. Fully-Latin documents (an English textbook converted
 * from PDF) never trigger the absorption because the document-wide gate fails.
 */
export const CODE_LABEL_NAME_RE = /^[A-Za-z][A-Za-z0-9 ./+&#()_-]{0,31}$/

/**
 * PDF font CMap mis-maps observed in the wild, repaired phrase-level so a
 * single rare legitimate character is never rewritten blindly.
 */
const CJK_PHRASE_REPAIRS: Array<[string, string]> = [
  ['运襾', '运行'],
  ['運襾', '運行'],
]

/** Sentence-ending punctuation indicating body text, not a heading. */
const SENTENCE_END_RE = /[。；，,.!?]$/

const PDF_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|rtf|odt)$/i
const MD_EXT_RE = /\.mdx?$/i

/**
 * Classify the required preprocessing depth from the source file extension.
 * PDF-style outputs (markitdown) need aggressive structure repair:
 * markitdown emits fake H1 headings for code-block labels (e.g. `# Response`)
 * while real Chinese numbered section lines (`一、`) are left as plain text.
 * Native markdown files should be left structurally untouched.
 */
function preprocessModeFor(sourceName: string): 'pdf' | 'native' {
  if (PDF_EXT_RE.test(sourceName)) return 'pdf'
  // Files with no extension or text/unknown extensions also get the
  // Chinese-numbered-section promotion (harmless when absent) but skip
  // heading demotion (we don't want to destroy any # headings that were
  // written intentionally).
  if (MD_EXT_RE.test(sourceName)) return 'native'
  return 'pdf' // default: assume scanned/unstructured
}

/**
 * General-purpose markdown/text preprocessing. The behavior adapts to the
 * source file type:
 *
 *  **PDF / unstructured sources** (`mode: 'pdf'`):
 *   - Normalize CJK Radical code-point substitutions to real ideographs
 *   - Repair known font mis-maps (phrase-level, see CJK_PHRASE_REPAIRS)
 *   - Promote Chinese-numbered lines to H1 markdown headings
 *   - Demote all existing markdown headings by one level so they nest under
 *     the real Chinese chapter headings (PDF-flattened text has no trustworthy
 *     heading semantics of its own)
 *
 *  **Native markdown sources** (`mode: 'native'`):
 *   - Only CJK Radical normalization + phrase repairs (safe, text-level fixes)
 *   - Heading structure and Chinese-numbered lines are left untouched
 *     so author intent is preserved.
 */
function preprocessMarkdown(text: string, sourceName: string): string {
  const mode = preprocessModeFor(sourceName)
  const lines = text.split(/\r?\n/)
  let inFence = false
  const result: string[] = []

  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; result.push(line); continue }
    if (inFence) { result.push(line); continue }

    // Step 1 — always: normalize CJK Radical → real ideograph and repair
    // known CMap mis-maps (safe, text-level; doesn't alter heading structure).
    let normalized = line
    for (const [bad, good] of CJK_PHRASE_REPAIRS) {
      normalized = normalized.replaceAll(bad, good)
    }
    for (const [radical, ideo] of Object.entries(RADICAL_TO_IDEOGRAPH)) {
      normalized = normalized.replaceAll(radical, ideo)
    }
    const trimmed = normalized.trim()

    // Step 2 — PDF-mode only: promote Chinese-numbered sections to H1.
    if (mode === 'pdf') {
      const cnMatch = /^([一二三四五六七八九十百千万亿兆零〇]+)、\s*(.+)$/.exec(trimmed)
      if (cnMatch !== null && !SENTENCE_END_RE.test(cnMatch[2]!)) {
        result.push(`# ${cnMatch[2]}`)
        continue
      }
    }

    // Step 3 — PDF-mode only: demote existing markdown headings by one level
    // so they sit as sub-sections under the promoted Chinese chapters.
    if (mode === 'pdf') {
      const mdMatch = /^(#{1,5})\s+(.+)$/.exec(normalized)
      if (mdMatch !== null) {
        result.push(`#${mdMatch[1]} ${mdMatch[2]}`)
        continue
      }
    }

    result.push(normalized)
  }
  return result.join('\n')
}

/** Markdown/text ingestor producing syllabus drafts and semantic chunks. */
export class MarkdownIngestor {
  constructor(
    readonly maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    readonly granularity: 'fine' | 'coarse' = 'fine',
  ) {
    if (maxChunkChars < 100) throw new Error('max_chunk_chars 过小，至少 100')
  }

  async parseAndChunk(sourcePath: string, courseId = 'course'): Promise<IngestArtifact> {
    const { readFile } = await import('node:fs/promises')
    let text: string
    try {
      text = await readFile(sourcePath, 'utf8')
    } catch (error) {
      throw new IngestError(`无法读取资料 ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.parseText(text, basename(sourcePath), courseId)
  }

  parseText(text: string, sourceName: string, courseId = 'course'): IngestArtifact {
    const processed = preprocessMarkdown(text, sourceName)
    const pdfMode = preprocessModeFor(sourceName) === 'pdf'
    // 「中文讲义里的英文代码注释岛」判定上下文：全文足够中文时，
    // 零中文的 ASCII 标签小节才按转换噪声处理（见 absorbCodeLabelSections）。
    const labelAbsorbEnabled = pdfMode && countCjk(processed) >= MIN_DOC_CJK_CHARS
    const lines = processed.split(/\r?\n/)
    const [meta, bodyStart] = extractFrontmatter(lines)
    const headings = scanHeadings(lines, bodyStart)
    const title = typeof meta['title'] === 'string' && meta['title'] !== ''
      ? meta['title']
      : firstH1(headings) ?? sourceName.replace(/\.[^.]+$/, '')

    const chapters: Syllabus['chapters'] = []
    const chunks: ConceptChunk[] = []
    const seenIds = new Set<string>()
    let chunkSeq = 0

    for (const draft of this.chapterDrafts(title, lines, headings, bodyStart)) {
      const chapterId = slug(draft.title, 'chap_', seenIds)
      const concepts: Syllabus['chapters'][number]['concepts'] = []
      const sections = this.absorbCodeLabelSections(this.conceptSections(draft, lines, headings), lines, draft.title, labelAbsorbEnabled)
      for (const section of sections) {
        const conceptId = slug(section.title, 'c_', seenIds)
        const [sectionChunks, nextSeq] = this.chunkSection(lines, section, sourceName, conceptId, chapterId, chunkSeq)
        chunkSeq = nextSeq
        if (sectionChunks.length === 0) continue
        chunks.push(...sectionChunks)
        concepts.push({ id: conceptId, name: section.title, type: conceptTypeOf(section.title), prerequisites: [], mastery_score: 0 })
      }
      if (concepts.length > 0) {
        chapters.push({ id: chapterId, title: draft.title, description: '', dependencies: [], concepts })
      }
    }

    return ingestArtifact.parse({
      source_file: sourceName,
      meta,
      syllabus: { course_id: courseId, title, version: '1.0.0', granularity: this.granularity, chapters, adjacency: {} },
      chunks,
    })
  }

  private chapterDrafts(title: string, lines: string[], headings: Heading[], bodyStart: number): SectionDraft[] {
    const total = lines.length
    if (headings.length === 0) return [{ title, start: bodyStart, end: total }]
    const chapterLevel = Math.min(...headings.map(heading => heading.level))
    const chapterHeads = headings.filter(heading => heading.level === chapterLevel)
    const drafts: SectionDraft[] = []
    const first = chapterHeads[0]!
    if (first.lineno > bodyStart) {
      // Skip pre-heading chapter if it's just a title line (< 3 non-empty lines)
      const preContent = lines.slice(bodyStart - 1, first.lineno - 1).filter(l => l.trim() !== '')
      if (preContent.length >= 3) drafts.push({ title, start: bodyStart, end: first.lineno - 1 })
    }
    for (let i = 0; i < chapterHeads.length; i += 1) {
      const head = chapterHeads[i]!
      const end = i + 1 < chapterHeads.length ? chapterHeads[i + 1]!.lineno - 1 : total
      drafts.push({ title: head.text, start: head.lineno, end })
    }
    return drafts
  }

  private conceptSections(chapter: SectionDraft, lines: string[], headings: Heading[]): SectionDraft[] {
    if (this.granularity === 'coarse') {
      return [{ title: chapter.title, start: chapter.start, end: Math.max(chapter.end, chapter.start) }]
    }
    const inner = headings.filter(heading => chapter.start < heading.lineno && heading.lineno <= chapter.end)
    const chapterLevel = headings.length > 0 ? Math.min(...headings.map(heading => heading.level)) : 0
    const subs = inner.filter(heading => chapterLevel < heading.level && heading.level <= chapterLevel + 2)

    const sections: SectionDraft[] = []
    const introEnd = subs.length > 0 ? subs[0]!.lineno - 1 : chapter.end
    const introStart = isHeadingLine(lines, chapter.start) ? chapter.start + 1 : chapter.start
    const introText = lines.slice(introStart - 1, introEnd).join('\n').trim()
    if (introText !== '' && introEnd >= introStart) {
      sections.push({ title: chapter.title, start: introStart, end: introEnd })
    }
    for (let i = 0; i < subs.length; i += 1) {
      const head = subs[i]!
      const end = i + 1 < subs.length ? subs[i + 1]!.lineno - 1 : chapter.end
      sections.push({ title: head.text, start: head.lineno, end })
    }
    if (sections.length === 0 && introText !== '') {
      sections.push({ title: chapter.title, start: chapter.start, end: chapter.end })
    }
    return sections
  }

  /**
   * 吸收「标签小节」（仅当 labelAbsorbEnabled：PDF 来源且全文中文密度达标）。
   * 判据组合＝纯 ASCII 标题 ＋ 小节正文零中文 —— 两者同时成立时这是
   * 中文讲义里被拍平的代码注释演示块，而不是知识点；内容并入上一节
   * （无上节则挂到章节标题下），保证不产生 Response 式垃圾概念，
   * 也绝不丢失代码内容。
   */
  private absorbCodeLabelSections(sections: SectionDraft[], lines: string[], chapterTitle: string, labelAbsorbEnabled: boolean): SectionDraft[] {
    if (!labelAbsorbEnabled) return sections
    const out: SectionDraft[] = []
    for (const section of sections) {
      if (!CODE_LABEL_NAME_RE.test(section.title)) { out.push(section); continue }
      if (rangeHasCjk(lines, section)) { out.push(section); continue }
      if (out.length > 0) {
        out[out.length - 1]!.end = section.end // 并入上一节，范围延伸覆盖标签区间
        continue
      }
      out.push({ ...section, title: chapterTitle }) // 无上节：保留在章节标题之下
    }
    return out
  }

  private chunkSection(
    lines: string[],
    section: SectionDraft,
    sourceName: string,
    conceptId: string,
    chapterId: string,
    chunkSeq: number,
  ): [ConceptChunk[], number] {
    const bodyStart = isHeadingLine(lines, section.start) ? section.start + 1 : section.start
    const paragraphs = splitParagraphs(lines, bodyStart, section.end)

    const chunks: ConceptChunk[] = []
    let bufParts: Array<[number, number, string]> = []
    let bufLen = 0
    const flush = (): void => {
      if (bufParts.length === 0) return
      chunkSeq += 1
      const start = bufParts[0]![0]
      const end = bufParts[bufParts.length - 1]![1]
      const content = bufParts.map(part => part[2]).join('\n\n')
      chunks.push(conceptChunk.parse({
        chunk_id: `chunk_${String(chunkSeq).padStart(3, '0')}`,
        chapter_id: chapterId,
        concept_id: conceptId,
        title: section.title,
        content,
        source_ref: { file: sourceName, chunk_id: `chunk_${String(chunkSeq).padStart(3, '0')}`, line_range: [start, end] },
      }))
    }

    for (const para of paragraphs) {
      const paraLen = para[2].length
      // F-17：超长单段硬拆——PDF 表格转出的数万字单段此前原样入块直灌 prompt。
      if (paraLen > this.maxChunkChars) {
        if (bufParts.length > 0) flush()
        const [subChunks, nextSeq] = splitOversizedParagraph(para, section, sourceName, conceptId, chapterId, chunkSeq, this.maxChunkChars)
        chunks.push(...subChunks)
        chunkSeq = nextSeq
        continue
      }
      if (bufParts.length > 0 && bufLen + paraLen > this.maxChunkChars) {
        flush()
        bufParts = []
        bufLen = 0
      }
      bufParts.push(para)
      bufLen += paraLen
    }
    flush()
    return [chunks, chunkSeq]
  }
}

/** F-17：把超长段落按标点/换行就近切成 ≤maxChars 的伪段并各自成块。 */
function splitOversizedParagraph(
  para: [number, number, string],
  section: SectionDraft,
  sourceName: string,
  conceptId: string,
  chapterId: string,
  seqStart: number,
  maxChars: number,
): [ConceptChunk[], number] {
  const text = para[2]
  const breakAfter = new Set(['。', '！', '？', '；', '\n', '.', '!', '?', ';'])
  const pieces: Array<{ start: number; end: number; text: string }> = []
  let cursor = 0
  let localCut = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + maxChars, text.length)
    if (end < text.length) {
      // 在窗口后半段找最近的句读点回退切分，避免概念句被拦腰截断。
      const window = text.slice(cursor, end)
      for (let back = window.length - 1; back >= Math.floor(window.length / 2); back -= 1) {
        if (breakAfter.has(window[back]!)) { localCut = back + 1; break }
      }
      if (localCut > 0 && cursor + localCut < text.length) end = cursor + localCut
    }
    const pieceText = text.slice(cursor, end)
    if (pieceText.trim() !== '') pieces.push({ start: cursor, end, text: pieceText })
    cursor = end
    localCut = 0
  }

  const chunks: ConceptChunk[] = []
  let chunkSeq = seqStart
  for (const piece of pieces) {
    chunkSeq += 1
    chunks.push(conceptChunk.parse({
      chunk_id: `chunk_${String(chunkSeq).padStart(3, '0')}`,
      chapter_id: chapterId,
      concept_id: conceptId,
      title: section.title,
      content: piece.text,
      source_ref: { file: sourceName, chunk_id: `chunk_${String(chunkSeq).padStart(3, '0')}`, line_range: [para[0], para[1]] },
    }))
  }
  return [chunks, chunkSeq]
}

function firstH1(headings: Heading[]): string | null {
  for (const heading of headings) {
    if (heading.level === 1) return heading.text
  }
  return null
}

export { syllabus as syllabusSchema }
