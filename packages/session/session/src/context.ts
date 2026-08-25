/**
 * ContextAssembler: per-turn system/user prompt rendering from the bundled
 * tutor templates plus live material (Agent.md persona, Memory.md profile,
 * syllabus + progress board, concept chunks from sources/). Ported from
 * Python `session.py::ContextAssembler`; the M2 concept-chunk matcher is a
 * light heading-slug port of MarkdownIngestor (full builder lands at M3).
 * @module @studyclaw/session/src/context
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TUTOR_MODES, TUTOR_SYSTEM, TUTOR_USER, renderTemplate } from './prompts.ts'
import type { LearningMode } from './models.ts'
import { SessionError } from './store.ts'

/** Syllabus + progress facts shared by the assembler and the tools layer. */
export interface CourseState {
  readonly title: string
  readonly version: string
  readonly chapters: Array<{ id: string; title: string; concepts: Array<{ id: string; name: string }> }>
  readonly concepts: Array<{ conceptId: string; name: string; chapter: string; mastery: number; evals: number; passRate: number }>
}

export async function loadCourseState(courseDir: string): Promise<CourseState> {
  const syllabusPath = join(courseDir, 'syllabus.json')
  let title = courseDir.split(/[\\/]/).pop() ?? courseDir
  let version = ''
  const chapters: CourseState['chapters'] = []
  const syllabus = await readFile(syllabusPath, 'utf8').catch(() => null)
  if (syllabus !== null) {
    try {
      const parsed = JSON.parse(syllabus) as {
        title?: string
        version?: string
        chapters?: Array<{ id: string; title: string; concepts?: Array<{ id: string; name: string }> }>
      }
      title = parsed.title ?? title
      version = parsed.version ?? ''
      for (const chapter of parsed.chapters ?? []) {
        chapters.push({ id: chapter.id, title: chapter.title, concepts: (chapter.concepts ?? []).map(c => ({ id: c.id, name: c.name })) })
      }
    } catch {
      // Corrupt syllabus: directory-name fallback.
    }
  }
  const concepts: CourseState['concepts'] = []
  const progressText = await readFile(join(courseDir, 'progress.md'), 'utf8').catch(() => '')
  const lines = progressText.split(/\r?\n/)
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.includes('concept_id')) { inTable = true; continue }
    if (!inTable) continue
    if (!trimmed.startsWith('|')) break
    const cells = trimmed.split('|').map(cell => cell.trim())
    // split('|') keeps a leading empty cell: [ '', id, name, chapter, mastery, evals, ... ]
    if (cells.length < 6) continue
    const separator = cells.slice(1).join('').replace(/[-\s:]/g, '')
    if (separator === '') continue
    const masteryRaw = cells[4] ?? '0'
    const mastery = masteryRaw.endsWith('%') ? Number(masteryRaw.slice(0, -1)) / 100 : Number(masteryRaw)
    concepts.push({
      conceptId: cells[1]!,
      name: cells[2]!,
      chapter: cells[3]!,
      mastery: Number.isFinite(mastery) ? Math.max(0, Math.min(1, mastery)) : 0,
      evals: Number(cells[5] ?? 0) || 0,
      passRate: 0,
    })
  }
  return { title, version, chapters, concepts }
}

/** The per-turn prompt renderer over one course. */
export class ContextAssembler {
  constructor(
    readonly courseDir: string,
    readonly workspaceRoot: string,
  ) {}

  modeInstruction(mode: LearningMode): string {
    const instruction = TUTOR_MODES[mode]
    if (instruction === undefined) throw new SessionError(`未配置学习模式提示词: ${mode}`)
    return instruction.trim()
  }

  async renderTurn(
    mode: LearningMode,
    userInput: string,
    conceptId: string | null = null,
  ): Promise<{ system: string; user: string }> {
    const state = await loadCourseState(this.courseDir)
    const system = renderTemplate(TUTOR_SYSTEM, {
      agent_persona: await this.agentPersona(),
      mode_instruction: this.modeInstruction(mode),
      memory: await this.memory(),
      course_state: this.courseStateText(state),
      concept_material: await this.conceptMaterial(conceptId),
    })
    const user = renderTemplate(TUTOR_USER, {
      recent_progress: this.recentProgress(state, conceptId),
      user_input: userInput,
    })
    return { system, user }
  }

  async assembleSystem(mode: LearningMode, conceptId: string | null = null): Promise<string> {
    return (await this.renderTurn(mode, '', conceptId)).system
  }

  async assembleUser(userInput: string, conceptId: string | null = null): Promise<string> {
    return (await this.renderTurn('socratic', userInput, conceptId)).user
  }

  private async agentPersona(): Promise<string> {
    const text = await readFile(join(this.workspaceRoot, '.studyclaw', 'Agent.md'), 'utf8').catch(() => null)
    return (text ?? '你是 StudyClaw 的苏格拉底式技术导师。').trim()
  }

  private async memory(): Promise<string> {
    const text = await readFile(join(this.workspaceRoot, '.studyclaw', 'Memory.md'), 'utf8').catch(() => null)
    return text === null || text.trim() === '' ? '（尚无沉淀）' : text.trim()
  }

  private courseStateText(state: CourseState): string {
    const lines: string[] = []
    lines.push(`大纲 v${state.version}：${state.title}`)
    for (const chapter of state.chapters) {
      lines.push(`- ${chapter.title}: ${chapter.concepts.map(c => c.name).join('、') || '（空）'}`)
    }
    if (state.concepts.length > 0) {
      lines.push('掌握度看板：')
      for (const c of state.concepts) {
        lines.push(`- ${c.conceptId} ${c.name}: 掌握度 ${Math.round(c.mastery * 100)}% / 评测 ${c.evals} 次`)
      }
    }
    return lines.join('\n') || '（课程暂无大纲与进度数据，可先运行 studyclaw build）'
  }

  private recentProgress(state: CourseState, conceptId: string | null): string {
    if (conceptId === null) return ''
    const record = state.concepts.find(c => c.conceptId === conceptId)
    if (record === undefined) return ''
    return [
      '## 该概念近期进度',
      `- 掌握度 ${Math.round(record.mastery * 100)}% · 评测 ${record.evals} 次 · 通过率 ${Math.round(record.passRate * 100)}%`,
    ].join('\n')
  }

  /** Best-effort concept chunks from sources/ (heading slug match; M3 replaces). */
  private async conceptMaterial(conceptId: string | null): Promise<string> {
    if (conceptId === null) return '（未指定聚焦概念；请围绕学生问题与课程资料作答）'
    const sourcesDir = join(this.courseDir, 'sources')
    if (!(await stat(sourcesDir).catch(() => null))?.isDirectory()) {
      return `（概念 ${conceptId} 暂无匹配资料切片）`
    }
    const state = await loadCourseState(this.courseDir)
    const conceptNames = new Set(state.concepts.map(c => c.conceptId))
    const blocks: string[] = []
    for (const entry of (await readdir(sourcesDir)).sort()) {
      if (!entry.endsWith('.md') && !entry.endsWith('.txt')) continue
      if (entry.startsWith('.')) continue
      const path = join(sourcesDir, entry)
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) continue
      const chunks = splitMarkdownChunks(text)
      for (const chunk of chunks) {
        const slug = chunk.title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '')
        const matches = slug === conceptId || conceptNames.has(chunk.title) && chunk.title === conceptId
        if (matches || chunk.conceptSlug === conceptId) {
          blocks.push(`### ${chunk.title}（${entry}）\n${chunk.content}`)
          if (blocks.length >= 3) return blocks.join('\n\n')
        }
      }
    }
    return `（概念 ${conceptId} 暂无匹配资料切片）`
  }
}

interface MarkdownChunk {
  readonly title: string
  readonly conceptSlug: string
  readonly content: string
}

/** Heading-based chunking: `## Title`/`### Title` sections (light port). */
function splitMarkdownChunks(text: string): MarkdownChunk[] {
  const lines = text.split(/\r?\n/)
  const chunks: MarkdownChunk[] = []
  let current: { title: string; content: string[] } | null = null
  const heading = /^(#{2,3})\s+(.+)$/
  for (const line of lines) {
    const match = heading.exec(line)
    if (match !== null) {
      if (current !== null) chunks.push(finalize(current))
      current = { title: match[2]!.trim(), content: [] }
      continue
    }
    if (current === null) continue
    current.content.push(line)
  }
  if (current !== null) chunks.push(finalize(current))
  return chunks

  function finalize(chunk: { title: string; content: string[] }): MarkdownChunk {
    const slug = chunk.title.toLowerCase().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '')
    return { title: chunk.title, conceptSlug: slug, content: chunk.content.join('\n').trim() }
  }
}
