/**
 * LLM dependency inferrer: 概念级先修关系推断。输入全书概念清单
 * （id/name/type/章节标题 + 内容摘要），structured call 输出
 * 每概念 prerequisites；输出经 sanitize（未知 id/自引用/去重）与
 * 环剔除后写回 syllabus（Python schemas.py 无环硬约束 parity）。
 * @module @studyclaw/course-builder/src/dep-infer
 */

import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { dependencyBatch, type ConceptDependency, type Chapter, type Syllabus } from './models.ts'
import { structuredCall, type StructuredCallClient } from './structured.ts'
import { DEP_INFER_SYSTEM, depInferUser } from './prompts.ts'

export const DEFAULT_MAX_RETRIES = 2

export interface DepInferrerOptions {
  maxRetries?: number
  model: string
  provider: string
  temperature?: number
}

/** 每概念内容摘要上限（字符），控制单次调用 token 量。 */
export const CONTENT_SNIPPET_LIMIT = 300

/**
 * 过滤非法依赖：未知 id、自引用、重复；保证结果只引用已知概念。
 * 不改变输入顺序（LLM 输出稳定性）。
 */
export function sanitizeDependencies(
  deps: ConceptDependency[],
  knownIds: ReadonlySet<string>,
): ConceptDependency[] {
  const out: ConceptDependency[] = []
  for (const entry of deps) {
    if (!knownIds.has(entry.conceptId)) continue
    const seen = new Set<string>()
    const prerequisites: string[] = []
    for (const prereq of entry.prerequisites) {
      if (prereq === entry.conceptId) continue
      if (!knownIds.has(prereq)) continue
      if (seen.has(prereq)) continue
      seen.add(prereq)
      prerequisites.push(prereq)
    }
    out.push({ conceptId: entry.conceptId, prerequisites })
  }
  return out
}

/**
 * 逐条尝试加入边（prereq → concept），加入后会成环的边直接丢弃。
 * 贪婪稳定：优先保留列表中靠前的边，输出恒为无环 DAG。
 */
export function acyclicEdges(edges: Array<[string, string]>): Array<[string, string]> {
  const adjacency = new Map<string, string[]>()
  const picked: Array<[string, string]> = []
  const addEdge = (from: string, to: string): void => {
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  const reaches = (from: string, target: string, visited: Set<string>): boolean => {
    if (from === target) return true
    for (const next of adjacency.get(from) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      if (reaches(next, target, visited)) return true
    }
    return false
  }
  for (const [prereq, concept] of edges) {
    // 已是 picked 图的一部分时，concept → ? → prereq 可达即成环
    if (reaches(concept, prereq, new Set())) continue
    addEdge(prereq, concept)
    picked.push([prereq, concept])
  }
  return picked
}

/**
 * 将 LLM 返回的依赖整形为可写回 syllabus 的形式：
 * 过滤非法 → 环剔除 → 恢复条目（保序；无先修的概念也保留空数组条目，
 * 使 LLM 的「清空」语义得以表达，避免过时依赖残留）。
 */
export function normalizeDependencies(
  deps: ConceptDependency[],
  knownIds: ReadonlySet<string>,
): ConceptDependency[] {
  const clean = sanitizeDependencies(deps, knownIds)
  const edges: Array<[string, string]> = []
  for (const entry of clean) {
    for (const prereq of entry.prerequisites) edges.push([prereq, entry.conceptId])
  }
  const acyclic = acyclicEdges(edges)
  const byConcept = new Map<string, string[]>()
  for (const [prereq, concept] of acyclic) {
    const list = byConcept.get(concept) ?? []
    list.push(prereq)
    byConcept.set(concept, list)
  }
  return clean.map((entry) => ({
    conceptId: entry.conceptId,
    prerequisites: byConcept.get(entry.conceptId) ?? [],
  }))
}

export interface DependencyInferenceResult {
  /** 全部概念条目（已 sanitize/无环，含空数组）。 */
  dependencies: ConceptDependency[]
}

/** 依赖推断端口（CourseBuilder 注入；测试可 mock）。 */
export interface DependencyInferrerLike {
  infer(syllabus: Syllabus, chunks: ReadonlyMap<string, string>): Promise<DependencyInferenceResult>
}

/**
 * 从概念级先修关系重建顶层 adjacency（Python schemas.py parity：
 * adjacency[dep].append(node)，即先修 → 后继的反向邻接表）。
 */
export function graphAdjacency(chapters: Chapter[]): Record<string, string[]> {
  const adjacency: Record<string, string[]> = {}
  for (const chapter of chapters) {
    for (const concept of chapter.concepts) {
      if (adjacency[concept.id] === undefined) adjacency[concept.id] = []
    }
  }
  for (const chapter of chapters) {
    for (const concept of chapter.concepts) {
      for (const prereq of concept.prerequisites) {
        if (adjacency[prereq] === undefined) continue
        adjacency[prereq]!.push(concept.id)
      }
    }
  }
  return adjacency
}

/** 章节级依赖投影：概念先修跨章节时，后继章节依赖先修章节；无环继承概念级无环。 */
export function projectChapterDependencies(chapters: Chapter[]): Record<string, string[]> {
  const chapterByConcept = new Map<string, string>()
  for (const chapter of chapters) {
    for (const concept of chapter.concepts) chapterByConcept.set(concept.id, chapter.id)
  }
  const out: Record<string, Set<string>> = {}
  for (const chapter of chapters) {
    if (out[chapter.id] === undefined) out[chapter.id] = new Set()
  }
  for (const chapter of chapters) {
    for (const concept of chapter.concepts) {
      for (const prereq of concept.prerequisites) {
        const prereqChapter = chapterByConcept.get(prereq)
        if (prereqChapter === undefined || prereqChapter === chapter.id) continue
        out[chapter.id]!.add(prereqChapter)
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([id, deps]) => [id, [...deps]]))
}

/**
 * LLM 结构化依赖推断：全书概念清单一次调用（复用 structuredCall 的
 * `_emit` 工具 + 文本 JSON 回退）。
 */
export class DependencyInferrer implements DependencyInferrerLike {
  constructor(
    private readonly client: StructuredCallClient,
    private readonly options: DepInferrerOptions,
  ) {}

  async infer(
    syllabus: Syllabus,
    chunks: ReadonlyMap<string, string>,
  ): Promise<DependencyInferenceResult> {
    const knownIds = new Set<string>()
    for (const chapter of syllabus.chapters) {
      for (const concept of chapter.concepts) knownIds.add(concept.id)
    }
    const batch = await structuredCall(
      this.client,
      dependencyBatch,
      this.generateOptions(syllabus, chunks),
      this.options.maxRetries ?? 2,
    )
    return { dependencies: normalizeDependencies(batch.conceptDependencies, knownIds) }
  }

  private generateOptions(syllabus: Syllabus, chunks: ReadonlyMap<string, string>): Omit<GenerateOptions, 'tools'> {
    return {
      provider: this.options.provider,
      model: this.options.model,
      system: DEP_INFER_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: depInferUser(syllabus, chunks, CONTENT_SNIPPET_LIMIT) }], source: { kind: 'user' } })],
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    }
  }
}

export { dependencyBatch }
