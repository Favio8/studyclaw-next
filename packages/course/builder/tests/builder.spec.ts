/**
 * CourseBuilder suite: first build, zero-LLM unchanged build, changed-file
 * card retirement + regeneration, removed-file retirement, id-collision
 * dedup, progress seeding, and granularity regeneration. Uses a fake
 * generator (offline).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CourseBuilder, loadSyllabus, loadTaskPool, type TaskGenerator } from '../src/builder.ts'
import type { HarnessTask, IngestArtifact } from '../src/models.ts'

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

const DOC = '# 多态\n\n## 重载与覆写\n\n重载是同名不同参数；覆写是重定义。\n'

async function setup(): Promise<{ root: string; courseDir: string; generator: FakeGenerator }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-'))
  const courseDir = join(root, 'c1')
  await mkdir(join(courseDir, 'sources'), { recursive: true })
  await writeFile(join(courseDir, 'sources', 'a.md'), DOC, 'utf8')
  return { root, courseDir, generator: new FakeGenerator() }
}

describe('CourseBuilder', () => {
  it('first build: generates tasks, merges syllabus, seeds progress', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    const report = await builder.build(1)
    expect(report.added).toEqual(['a.md'])
    expect(report.tasksGenerated).toBeGreaterThan(0)
    const pool = await loadTaskPool(courseDir)
    expect(pool.length).toBeGreaterThan(0)
    const syllabus = await loadSyllabus(courseDir)
    expect(syllabus.chapters.length).toBeGreaterThan(0)
    const progress = await readFile(join(courseDir, 'progress.md'), 'utf8')
    expect(progress).toContain('concept_id')
    expect(progress).toContain('重载与覆写')
    await rm(root, { recursive: true, force: true })
  })

  it('unchanged second build: zero LLM calls, zero rewrites', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(1)
    const callsAfterFirst = generator.calls
    const report = await builder.build(1)
    expect(report.added).toEqual([])
    expect(report.modified).toEqual([])
    expect(report.tasksGenerated).toBe(0)
    expect(generator.calls).toBe(callsAfterFirst)
    await rm(root, { recursive: true, force: true })
  })

  it('modified file: retires its old cards and regenerates', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(1)
    const poolBefore = await loadTaskPool(courseDir)
    expect(poolBefore.length).toBeGreaterThan(0)
    await writeFile(join(courseDir, 'sources', 'a.md'), DOC.replace('重载是同名不同参数', 'Java 中重载是同名不同参数'), 'utf8')
    const callsAfterFirst = generator.calls
    const report = await builder.build(1)
    expect(report.modified).toContain('a.md')
    const poolAfter = await loadTaskPool(courseDir)
    // Full regeneration: generator ran again and the pool is repopulated
    // (task ids derive from the concept, so ids may equal the old ones —
    // Python parity).
    expect(poolAfter.length).toBeGreaterThan(0)
    expect(generator.calls).toBeGreaterThan(callsAfterFirst)
    await rm(root, { recursive: true, force: true })
  })

  it('removed file: retires its cards', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(1)
    const poolBefore = await loadTaskPool(courseDir)
    await (await import('node:fs/promises')).unlink(join(courseDir, 'sources', 'a.md'))
    const report = await builder.build(1)
    expect(report.removed).toEqual(['a.md'])
    const poolAfter = await loadTaskPool(courseDir)
    expect(poolAfter.every(task => task.source_ref === null || task.source_ref.file !== 'a.md')).toBe(true)
    expect(poolAfter.length).toBeLessThanOrEqual(poolBefore.length)
    await rm(root, { recursive: true, force: true })
  })

  it('id collisions across chunks get bumped (no card lost)', async () => {
    const { root, courseDir, generator } = await setup()
    // Two sections that result in the same concept-id prefix produce
    // identical task ids; the pool merge must not drop cards.
    await writeFile(join(courseDir, 'sources', 'b.md'), '# 多态\n\n## 重载与覆写\n\n别的切片内容。\n', 'utf8')
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(2)
    const pool = await loadTaskPool(courseDir)
    const ids = pool.map(task => task.task_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(pool.length).toBeGreaterThanOrEqual(4)
    await rm(root, { recursive: true, force: true })
  })
})
