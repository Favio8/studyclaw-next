/**
 * Dependency inferrer suite: sanitize (unknown/self/dup), cycle breaking,
 * normalize (empty-entry preservation), adjacency rebuild, chapter-level
 * projection, and CourseBuilder integration (write-back / degraded / no-op).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acyclicEdges,
  graphAdjacency,
  normalizeDependencies,
  projectChapterDependencies,
  sanitizeDependencies,
  type DependencyInferrerLike,
} from '../src/dep-infer.ts'
import { CourseBuilder, loadSyllabus } from '../src/builder.ts'
import type { ConceptDependency, HarnessTask, IngestArtifact, Syllabus } from '../src/models.ts'
import type { TaskGenerator } from '../src/builder.ts'

class FakeGenerator implements TaskGenerator {
  async generateTasks(_chunk: IngestArtifact['chunks'][number], count: number): Promise<HarnessTask[]> {
    return Array.from({ length: count }, (_, index) => ({
      task_id: `task_${index}`,
      concept_id: _chunk.concept_id,
      source_ref: _chunk.source_ref,
      type: 'concept',
      difficulty: 1,
      question: 'q',
      options: null,
      evaluation_criteria: { rubric: ['a', 'b'], keywords: [] },
      history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
      deprecated: false,
      dynamic: false,
      target_id: null,
    }))
  }
}

describe('sanitizeDependencies', () => {
  const known = new Set(['c_a', 'c_b', 'c_c'])

  it('drops unknown ids, self-references and duplicates', () => {
    const input: ConceptDependency[] = [
      { conceptId: 'c_a', prerequisites: ['c_b', 'c_b', 'c_a', 'c_ghost'] },
      { conceptId: 'c_b', prerequisites: [] },
      { conceptId: 'c_ghost', prerequisites: ['c_a'] }, // 未知概念整条丢弃
    ]
    const out = sanitizeDependencies(input, known)
    expect(out).toEqual([
      { conceptId: 'c_a', prerequisites: ['c_b'] },
      { conceptId: 'c_b', prerequisites: [] },
    ])
  })
})

describe('acyclicEdges', () => {
  it('breaks a 3-node cycle keeping the prefix edges', () => {
    const edges: Array<[string, string]> = [
      ['c_a', 'c_b'],
      ['c_b', 'c_c'],
      ['c_c', 'c_a'], // 成环边被丢弃
    ]
    expect(acyclicEdges(edges)).toEqual([
      ['c_a', 'c_b'],
      ['c_b', 'c_c'],
    ])
  })

  it('keeps a valid DAG untouched', () => {
    const edges: Array<[string, string]> = [
      ['c_a', 'c_b'],
      ['c_a', 'c_c'],
      ['c_b', 'c_c'],
    ]
    expect(acyclicEdges(edges)).toEqual(edges)
  })

  it('handles a self-loop (a -> a) by dropping it', () => {
    expect(acyclicEdges([['c_a', 'c_a']])).toEqual([])
  })
})

describe('normalizeDependencies', () => {
  const known = new Set(['c_a', 'c_b', 'c_c'])

  it('preserves empty entries so LLM clarifications can be expressed', () => {
    const input: ConceptDependency[] = [
      { conceptId: 'c_a', prerequisites: [] },
      { conceptId: 'c_b', prerequisites: ['c_a'] },
      { conceptId: 'c_c', prerequisites: ['c_b', 'c_b'] },
    ]
    expect(normalizeDependencies(input, known)).toEqual([
      { conceptId: 'c_a', prerequisites: [] },
      { conceptId: 'c_b', prerequisites: ['c_a'] },
      { conceptId: 'c_c', prerequisites: ['c_b'] },
    ])
  })

  it('returns empty when nothing valid is left', () => {
    expect(normalizeDependencies([{ conceptId: 'c_ghost', prerequisites: [] }], known)).toEqual([])
  })
})

describe('graphAdjacency', () => {
  it('maps prereq -> [dependents] (Python parity) and includes isolated nodes', () => {
    const syllabus: Syllabus = {
      course_id: 'c1',
      title: 't',
      version: '1.0.0',
      granularity: 'fine',
      chapters: [
        { id: 'chap_1', title: '一', description: '', dependencies: [], concepts: [
          { id: 'c_a', name: 'A', type: 'mechanism', prerequisites: [], mastery_score: 0 },
          { id: 'c_b', name: 'B', type: 'mechanism', prerequisites: ['c_a'], mastery_score: 0 },
        ] },
      ],
      adjacency: {},
    }
    expect(graphAdjacency(syllabus.chapters)).toEqual({ c_a: ['c_b'], c_b: [] })
  })
})

describe('projectChapterDependencies', () => {
  it('projects cross-chapter concept edges to chapter deps and skips same-chapter', () => {
    const syllabus: Syllabus = {
      course_id: 'c1',
      title: 't',
      version: '1.0.0',
      granularity: 'fine',
      chapters: [
        { id: 'chap_a', title: 'A', description: '', dependencies: [], concepts: [
          { id: 'c_a1', name: 'A1', type: 'mechanism', prerequisites: [], mastery_score: 0 },
        ] },
        { id: 'chap_b', title: 'B', description: '', dependencies: [], concepts: [
          { id: 'c_b1', name: 'B1', type: 'mechanism', prerequisites: ['c_a1'], mastery_score: 0 },
          { id: 'c_b2', name: 'B2', type: 'mechanism', prerequisites: ['c_b1'], mastery_score: 0 },
        ] },
      ],
      adjacency: {},
    }
    expect(projectChapterDependencies(syllabus.chapters)).toEqual({ chap_a: [], chap_b: ['chap_a'] })
  })
})

describe('CourseBuilder dependency inference integration', () => {
  const DOC = '# 多态\n\n## 重载与覆写\n\n重载是同名不同参数；覆写是重定义。\n\n## 多态传参\n\n父类引用指向子类对象时，实际调用的方法由运行时类型决定。\n'

  class FakeInferrer implements DependencyInferrerLike {
    calls: Array<{ syllabus: Syllabus; chunks: ReadonlyMap<string, string> }> = []
    result: { dependencies: ConceptDependency[] } | null = null

    async infer(syllabus: Syllabus, chunks: ReadonlyMap<string, string>) {
      this.calls.push({ syllabus, chunks })
      if (this.result === null) throw new Error('infer failed')
      return this.result
    }
  }

  async function setup(inferrer: FakeInferrer): Promise<{ root: string; courseDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-dep-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, 'sources'), { recursive: true })
    await writeFile(join(courseDir, 'sources', 'a.md'), DOC, 'utf8')
    return { root, courseDir }
  }

  it('writes inferred prerequisites + adjacency + chapter deps and bumps version', async () => {
    const { root, courseDir } = await setup(new FakeInferrer())
    // 先建一轮得到真实概念 id（中文标题回退 md5 id），随后修改文件触发增量构建
    const emptyInferrer = new FakeInferrer()
    emptyInferrer.result = { dependencies: [] }
    await new CourseBuilder(courseDir, new FakeGenerator(), emptyInferrer).build(1)
    const before = await loadSyllabus(courseDir)
    const conceptA = before.chapters[0]!.concepts[0]!.id
    const conceptB = before.chapters[0]!.concepts[1]!.id
    await writeFile(join(courseDir, 'sources', 'a.md'), `${DOC}\n\n补充内容触发增量构建。\n`, 'utf8')

    const inferrer = new FakeInferrer()
    inferrer.result = {
      dependencies: [{ conceptId: conceptA, prerequisites: [conceptB] }, { conceptId: conceptB, prerequisites: [] }],
    }
    const builder = new CourseBuilder(courseDir, new FakeGenerator(), inferrer)
    const report = await builder.build(1)
    expect(inferrer.calls.length).toBe(1)
    const syllabus = await loadSyllabus(courseDir)
    const hit = syllabus.chapters[0]!.concepts.find(c => c.id === conceptA)!
    expect(hit.prerequisites).toEqual([conceptB])
    expect(syllabus.adjacency).toMatchObject({ [conceptB]: [conceptA] })
    expect(report.version).not.toBe(before.version)
    expect(report.degraded).not.toContain('dependencies')
    await rm(root, { recursive: true, force: true })
  })

  it('degrades gracefully and keeps the prior syllabus on inference failure', async () => {
    const inferrer = new FakeInferrer() // result=null → throw
    const { root, courseDir } = await setup(inferrer)
    const builder = new CourseBuilder(courseDir, new FakeGenerator(), inferrer)
    const report = await builder.build(1)
    expect(report.degraded).toContain('dependencies')
    const raw = await readFile(join(courseDir, 'syllabus.json'), 'utf8')
    expect(raw).toContain('"prerequisites": []')
    await rm(root, { recursive: true, force: true })
  })

  it('stays a no-op when no inferrer is injected', async () => {
    const { root, courseDir } = await setup(new FakeInferrer())
    const builder = new CourseBuilder(courseDir, new FakeGenerator())
    const report = await builder.build(1)
    expect(report.degraded).not.toContain('dependencies')
    const syllabus = await loadSyllabus(courseDir)
    expect(syllabus.chapters[0]!.concepts.every(c => c.prerequisites.length === 0)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})
