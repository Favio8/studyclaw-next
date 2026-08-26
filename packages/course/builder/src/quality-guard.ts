import type { Syllabus } from './models.ts'

export type SyllabusQualityIssueCode =
  | 'name-whitespace'
  | 'name-too-long'
  | 'duplicate-name'
  | 'empty-chapter'
  | 'too-many-chapters'
  | 'too-many-concepts'

export interface SyllabusQualityIssue {
  code: SyllabusQualityIssueCode
  detail: string
}

export const MAX_CONCEPT_NAME_LENGTH = 24
export const MAX_CHAPTERS = 12
export const MAX_CONCEPTS = 120
/** fine 粒度允许的章节数上限（LLM 输出偏离时的预警线，不阻塞构建）。 */
export const MAX_CHAPTERS_FINE = 10

/** 规整名称：剔除控制字符、压缩连续空白、去掉首尾空白。 */
export function normalizeName(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 大纲质量校验（纯函数，immutable，只读检查）：
 * 概念/章节名净化、长度上限、重复名、空章节、规模护栏。
 * 用于 LLM 生成内容回写 syllabus 前的最后一道防线（前端因此能拿到
 * 稳定展示的文本；问题进入 BuildReport.degraded 但不阻塞构建）。
 */
export function checkSyllabusQuality(syllabus: Syllabus): SyllabusQualityIssue[] {
  const issues: SyllabusQualityIssue[] = []
  const names = new Map<string, string>()

  for (const chapter of syllabus.chapters) {
    const concepts = chapter.concepts ?? []
    if (concepts.length === 0) {
      issues.push({ code: 'empty-chapter', detail: `章节「${chapter.title}」无概念节点` })
    }
    for (const concept of concepts) {
      const clean = normalizeName(concept.name)
      if (clean !== concept.name) {
        issues.push({ code: 'name-whitespace', detail: `概念「${concept.name}」名称含不规整空白` })
      }
      if (concept.name.length > MAX_CONCEPT_NAME_LENGTH) {
        issues.push({
          code: 'name-too-long',
          detail: `概念「${concept.name}」名称达 ${concept.name.length} 字（上限 ${MAX_CONCEPT_NAME_LENGTH}）`,
        })
      }
      const seen = names.get(clean)
      if (seen !== undefined && seen !== concept.id) {
        issues.push({ code: 'duplicate-name', detail: `概念名「${clean}」在 ${seen} 与 ${concept.id} 重复` })
      } else if (seen === undefined) {
        names.set(clean, concept.id)
      }
    }
  }

  const totalConcepts = syllabus.chapters.reduce((sum, chapter) => sum + (chapter.concepts?.length ?? 0), 0)
  if (syllabus.chapters.length > MAX_CHAPTERS_FINE) {
    issues.push({ code: 'too-many-chapters', detail: `章节数 ${syllabus.chapters.length}（预期 ≤ ${MAX_CHAPTERS_FINE}）` })
  }
  if (syllabus.chapters.length > MAX_CHAPTERS) {
    issues.push({ code: 'too-many-chapters', detail: `章节数 ${syllabus.chapters.length} 超过硬上限 ${MAX_CHAPTERS}` })
  }
  if (totalConcepts > MAX_CONCEPTS) {
    issues.push({ code: 'too-many-concepts', detail: `概念总数 ${totalConcepts}（上限 ${MAX_CONCEPTS}）` })
  }
  return issues
}

/**
 * 应用可安全修复的规则（名称空白净化），其余问题只上报不改内容。
 * 无变化时原样返回（syllabus 引用不变），便于调用方判断是否需要写回。
 */
export function applySyllabusQualityGuard(syllabus: Syllabus): { syllabus: Syllabus; issues: SyllabusQualityIssue[] } {
  const issues = checkSyllabusQuality(syllabus)
  let changed = false
  const chapters = syllabus.chapters.map((chapter) => {
    const concepts = chapter.concepts ?? []
    let chapterChanged = false
    const nextConcepts = concepts.map((concept) => {
      const clean = normalizeName(concept.name)
      if (clean === concept.name) return concept
      chapterChanged = true
      return { ...concept, name: clean }
    })
    if (!chapterChanged) return chapter
    changed = true
    return { ...chapter, concepts: nextConcepts }
  })
  if (!changed) return { syllabus, issues }
  return { syllabus: { ...syllabus, chapters }, issues }
}
