/**
 * 临时测试脚本：在 harness_learning 课程的**临时副本**上跑粒度重生成，
 * 验证依赖推断端到端（真实 mock LLM → structuredCall → sanitize → 写回）；
 * 随后用确定性 FakeInferrer 再跑一遍验证写回产物。不修改用户原始课程数据。
 *
 * 用法：tsx --tsconfig tsconfig.base.json scripts/dep-infer-e2e.ts
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const COURSE_SRC = 'C:/Users/Favio/Desktop/harness_learning/courses/harness-learning-mt6o7txk'
const WORKSPACE_ROOT = 'C:/Users/Favio/Desktop/harness_learning'

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'hl-e2e-'))
  const dir = join(tmp, basename(COURSE_SRC))
  await cp(COURSE_SRC, dir, { recursive: true })
  console.log('副本目录:', dir)

  // --- A. 真实 mock LLM 推断（可失败 → 降级路径） ---
  const { loadChatConfig } = await import('../packages/host/chat-service/src/config.ts')
  const { createDeepSeekToolClient } = await import('../packages/host/chat-service/src/adapter.ts')
  const { CourseBuilder, DependencyInferrer, loadSyllabus } = await import('../packages/course/builder/src/index.ts')
  const config = await loadChatConfig(WORKSPACE_ROOT)
  console.log('配置加载:', config === null ? 'null' : `provider=${config.providerId} model=${config.model} base=${config.baseUrl}`)

  const inferrer = new DependencyInferrer(createDeepSeekToolClient(config), {
    model: config.model,
    provider: config.providerId || 'studyclaw',
    temperature: config.temperature,
  })
  const quietGenerator = { generateTasks: async () => [] }
  let builder = new CourseBuilder(dir, quietGenerator as never, inferrer)
  const reportA = await builder.regenerateSyllabus('fine')
  const syllabusA = await loadSyllabus(dir)
  console.log('--- A. 真实 LLM (mock) 推断 ---')
  console.log('degraded:', JSON.stringify(reportA.degraded))
  console.log('version:', reportA.version, '| 有先修边的概念数:', syllabusA.chapters.reduce((n, ch) => n + ch.concepts.filter(c => c.prerequisites.length > 0).length, 0))

  // --- B. 确定性 FakeInferrer（模拟 LLM 判定：Anthropic → Chat Completions → Response） ---
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
  // 重新复制一份（A 可能已污染副本 checksums/version）
  await rm(dir, { recursive: true, force: true })
  await cp(COURSE_SRC, dir, { recursive: true })
  builder = new CourseBuilder(dir, quietGenerator as never, new FakeInferrer() as never)
  const reportB = await builder.regenerateSyllabus('fine')
  const syllabusB = await loadSyllabus(dir)
  console.log('--- B. 确定性推断（写回验证） ---')
  console.log('degraded:', JSON.stringify(reportB.degraded), '| version:', reportB.version)
  for (const ch of syllabusB.chapters) {
    console.log(`章节 ${ch.id}「${ch.title}」deps=${JSON.stringify(ch.dependencies)}`)
    for (const c of ch.concepts) console.log(`  ${c.id}「${c.name}」prerequisites=${JSON.stringify(c.prerequisites)}`)
  }
  console.log('adjacency:', JSON.stringify(syllabusB.adjacency))
  const raw = await readFile(join(dir, 'syllabus.json'), 'utf8')
  const parsed = JSON.parse(raw) as { adjacency: Record<string, string[]> }
  const hasEdge = Object.values(parsed.adjacency).some(v => v.length > 0)
  console.log('写回验证 adjacency 无环/非空:', hasEdge)

  await rm(tmp, { recursive: true, force: true })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
