import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const COURSE_SRC = 'C:/Users/Favio/Desktop/harness_learning/courses/harness-learning-mt6o7txk'

class FakeInferrer {
  async infer(syllabus: { chapters: Array<{ concepts: Array<{ id: string }> }> }, _chunks: unknown) {
    const ids = syllabus.chapters.flatMap(ch => ch.concepts.map(c => c.id))
    const pick = (name: string) => ids.find(id => id.startsWith(`c_${name}`)) ?? ids[0]!
    return {
      dependencies: [
        { conceptId: pick('chat_completions'), prerequisites: [pick('response')] },
        { conceptId: pick('anthropic'), prerequisites: [pick('chat_completions')] },
        { conceptId: pick('response'), prerequisites: [] },
      ],
    }
  }
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'hl-diag-'))
  const dir = join(tmp, basename(COURSE_SRC))
  await cp(COURSE_SRC, dir, { recursive: true })
  const { CourseBuilder, loadSyllabus } = await import('../packages/course/builder/src/index.ts')
  const quietGenerator = { generateTasks: async () => [] }
  const builder = new CourseBuilder(dir, quietGenerator as never, new FakeInferrer() as never)
  const report = await builder.regenerateSyllabus('fine')
  const syllabus = await loadSyllabus(dir)
  console.log('degraded:', JSON.stringify(report.degraded), '| version:', report.version)
  for (const ch of syllabus.chapters) {
    console.log(`章节 ${ch.id}「${ch.title}」deps=${JSON.stringify(ch.dependencies)}`)
    for (const c of ch.concepts) console.log(`  ${c.id}「${c.name}」prerequisites=${JSON.stringify(c.prerequisites)}`)
  }
  console.log('adjacency:', JSON.stringify(syllabus.adjacency))
  const raw = await readFile(join(dir, 'syllabus.json'), 'utf8')
  const parsed = JSON.parse(raw) as { adjacency: Record<string, string[]> }
  const hasEdge = Object.values(parsed.adjacency).some(v => v.length > 0)
  console.log('写回验证 adjacency 非空/无环:', hasEdge)
  await rm(tmp, { recursive: true, force: true })
}

main()
  .then(() => console.log('DIAG_OK'))
  .catch((e: unknown) => {
    console.error('DIAG_ERR', e)
    console.error(e instanceof Error ? e.stack : '')
  })
