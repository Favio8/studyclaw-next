/**
 * CourseBuilder suite: first build, zero-LLM unchanged build, changed-file
 * card retirement + regeneration, removed-file retirement, id-collision
 * dedup, progress seeding, and granularity regeneration. Uses a fake
 * generator (offline).
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CourseBuilder, loadSyllabus, loadTaskPool, migrateLegacyLayout, MAX_SOURCE_FILE_BYTES, type TaskGenerator } from '../src/builder.ts'
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
    const progress = await readFile(join(courseDir, '.studyclaw', 'progress.md'), 'utf8')
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

  it('T-20：增量 build 只重解析变更文件，跨资料同名概念 id 不撞车', async () => {
    // 两个讲义都有「概述」——旧实现（含只提实例级 seen 的中间态）在全量 build
    // 下不撞，但增量 build 用全新 ingestor 只解析变更文件，会把 b.md 的「概述」
    // 重新分配成干净 id，与 a.md 的「概述」撞成同一 concept id（掌握度跨资料
    // 混用），并留下没人再生产的 _2 僵尸行。现在按 source_file 归属为其他资料
    // 预留 id，变更文件稳定复得自己的 _2 后缀。
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, 'sources'), { recursive: true })
    await writeFile(join(courseDir, 'sources', 'a.md'), '# 讲义A\n\n## 概述\n\nA 的概述内容。\n', 'utf8')
    await writeFile(join(courseDir, 'sources', 'b.md'), '# 讲义B\n\n## 概述\n\nB 的概述内容。\n', 'utf8')
    await new CourseBuilder(courseDir, new FakeGenerator()).build(1)

    const conceptIdsOf = async (title: string): Promise<string[]> => {
      const syllabus = await loadSyllabus(courseDir)
      return syllabus.chapters.find(chapter => chapter.title === title)!.concepts.map(concept => concept.id)
    }
    const beforeA = await conceptIdsOf('讲义A')
    const beforeB = await conceptIdsOf('讲义B')
    expect(beforeA.length).toBeGreaterThan(0)
    expect(beforeB).not.toEqual(beforeA) // 全量 build：第二个资料得 _2 后缀

    // 只改 b.md → 增量 build 只重解析它（全新 ingestor）。
    await writeFile(join(courseDir, 'sources', 'b.md'), '# 讲义B\n\n## 概述\n\nB 的概述内容（修订）。\n', 'utf8')
    await new CourseBuilder(courseDir, new FakeGenerator()).build(1)

    const all = (await loadSyllabus(courseDir)).chapters.flatMap(chapter => chapter.concepts.map(concept => concept.id))
    expect(new Set(all).size).toBe(all.length) // 没有任何 concept id 跨资料撞车
    expect(await conceptIdsOf('讲义A')).toEqual(beforeA) // 未变更资料原样不动
    expect(await conceptIdsOf('讲义B')).toEqual(beforeB) // 变更资料稳定复得自己的 id
    await rm(root, { recursive: true, force: true })
  })

  it('M2：生成失败时旧卡保留、checksums 不落盘（先删后生成回归）', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(1)
    const poolBefore = await loadTaskPool(courseDir)
    expect(poolBefore.length).toBeGreaterThan(0)
    const checksumsBefore = await readFile(join(courseDir, '.studyclaw', '.checksums'), 'utf8')
    // 修改文件触发重建，但生成器抛错（模拟 LLM 故障/限流）。
    await writeFile(join(courseDir, 'sources', 'a.md'), DOC.replace('重载是同名不同参数', 'Java 中重载是同名不同参数'), 'utf8')
    generator.calls = -1 // 下次调用抛错
    generator.generateTasks = async () => { throw new Error('LLM rate limited') }
    await expect(builder.build(1)).rejects.toThrow('LLM rate limited')
    // 旧卡未被删除；checksums 未更新 → 下次构建仍会把 a.md 视为 modified 重试。
    const poolAfter = await loadTaskPool(courseDir)
    expect(poolAfter).toHaveLength(poolBefore.length)
    expect(await readFile(join(courseDir, '.studyclaw', '.checksums'), 'utf8')).toBe(checksumsBefore)
    await rm(root, { recursive: true, force: true })
  })

  it('T-3：并发 regenerateSyllabus 不互踩临时文件（随机 tmp + granularity 写段上锁）', async () => {
    const { root, courseDir, generator } = await setup()
    const builder = new CourseBuilder(courseDir, generator)
    await builder.build(1)
    // 两个并发粒度重切：旧实现固定 `path+'.tmp'` 名，两个写流交错写同一 tmp →
    // rename 出混合内容（syllabus.json 损坏 → loadSyllabus 回退空大纲）或 ENOENT。
    await Promise.all([builder.regenerateSyllabus('coarse'), builder.regenerateSyllabus('coarse')])
    const syllabus = await loadSyllabus(courseDir)
    expect(syllabus.granularity).toBe('coarse')
    expect(syllabus.chapters.length).toBeGreaterThan(0)
    // 无临时文件残留（旧实现竞态下 rename 失败会留下 .tmp）。
    const stateFiles = await readdir(join(courseDir, '.studyclaw'))
    expect(stateFiles.some(name => name.includes('.tmp'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('T-6：批量生成首个失败即停止认领（在途单元结算后不再起新 LLM 调用）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-failfast-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, 'sources'), { recursive: true })
    // 三个切片 → 三个生成单元；并发 2。第 2 个调用早失败，成功的调用慢——
    // 旧实现失败后其余 worker 仍把剩余队列跑完（白烧 LLM 调用）。
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await writeFile(join(courseDir, 'sources', name), `# 主题\n\n## ${name} 概念\n\n内容。\n`, 'utf8')
    }
    let calls = 0
    const generator: TaskGenerator = {
      async generateTasks(chunk, count) {
        calls += 1
        const mine = calls
        await new Promise(resolve => setTimeout(resolve, mine === 2 ? 5 : 30))
        if (mine === 2) throw new Error('LLM rate limited')
        return Array.from({ length: count }, (_, index) => ({
          task_id: `${chunk.concept_id.replace(/^c_/, '')}_00${index + 1}`,
          concept_id: chunk.concept_id,
          source_ref: chunk.source_ref,
          type: 'concept' as const,
          difficulty: 2,
          question: `关于「${chunk.title}」的问题 ${index + 1}`,
          options: null,
          evaluation_criteria: { rubric: ['要点一', '要点二'], keywords: [chunk.title] },
          history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
          deprecated: false,
          dynamic: false,
          target_id: null,
        }))
      },
    }
    const builder = new CourseBuilder(courseDir, generator)
    await expect(builder.build(1, undefined, undefined, 2)).rejects.toThrow('LLM rate limited')
    // 等在途单元结算完毕：失败已发生时不再认领第 3 个单元（旧实现会）。
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(calls).toBe(2)
    await rm(root, { recursive: true, force: true })
  })

  it('T-7：超过大小上限的源文件被跳过并进 degraded（构建内存守卫）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-bigfile-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, 'sources'), { recursive: true })
    await writeFile(join(courseDir, 'sources', 'a.md'), DOC, 'utf8')
    // 64MB+1 的巨型文件：旧实现整文件 readFile 进内存（checksum 阶段）。
    await writeFile(join(courseDir, 'sources', 'huge.md'), Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 0x61), 'utf8')
    const builder = new CourseBuilder(courseDir, new FakeGenerator())
    const report = await builder.build(1)
    expect(report.degraded.some(line => line.includes('huge.md') && line.includes('上限'))).toBe(true)
    // 正常文件仍被摄取（守卫不误伤）。
    expect(report.added).toContain('a.md')
    await rm(root, { recursive: true, force: true })
  })

  it('T-10：布局迁移 rename 失败时不写 marker（半迁移不永久化，下次重试）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-halfmigrate-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    await writeFile(join(courseDir, 'progress.md'), '# 旧布局看板\n', 'utf8')
    // 注入必失败的 move（模拟占用/杀软锁定导致的 EPERM/EBUSY）。
    await migrateLegacyLayout(courseDir, async () => { throw new Error('EPERM simulated') })
    // marker 未落 → 下次启动会重试迁移（旧实现吞错后写 marker，半迁移被洗白）。
    const marker = join(courseDir, '.studyclaw', '.layout-v2')
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    // 根目录遗留原样未动。
    await expect(readFile(join(courseDir, 'progress.md'), 'utf8')).resolves.toContain('旧布局看板')
    await rm(root, { recursive: true, force: true })
  })

  it('T-10：迁移成功时 marker 落盘且幂等（二次调用直接返回）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-builder-migrate-ok-'))
    const courseDir = join(root, 'c1')
    await mkdir(join(courseDir, '.studyclaw'), { recursive: true })
    await writeFile(join(courseDir, 'progress.md'), '# 旧布局看板\n', 'utf8')
    await migrateLegacyLayout(courseDir)
    const marker = join(courseDir, '.studyclaw', '.layout-v2')
    await expect(readFile(marker, 'utf8')).resolves.toBe('v2\n')
    await expect(readFile(join(courseDir, '.studyclaw', 'progress.md'), 'utf8')).resolves.toContain('旧布局看板')
    // 幂等：二次调用不重复迁移、不抛错。
    await migrateLegacyLayout(courseDir)
    await rm(root, { recursive: true, force: true })
  })
})
