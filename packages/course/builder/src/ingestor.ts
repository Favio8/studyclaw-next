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
    const lines = text.split(/\r?\n/)
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
      for (const section of this.conceptSections(draft, lines, headings)) {
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
    if (first.lineno > bodyStart) drafts.push({ title, start: bodyStart, end: first.lineno - 1 })
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

function firstH1(headings: Heading[]): string | null {
  for (const heading of headings) {
    if (heading.level === 1) return heading.text
  }
  return null
}

export { syllabus as syllabusSchema }
