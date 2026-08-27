/**
 * 题卡质量 A 档实测：临时工作区 + 真实 LLM 生成一批卡，
 * 校验答案键/选项长度均衡/难度与题型轮换/质量闸。
 * 用法：npx tsx scripts/_dbg_gen_quality.ts <workspaceWithConfig>
 */
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChatConfig } from '../packages/host/chat-service/src/config.ts'
import { LlmTaskGenerator, generationTargets, enforceTaskQuality, answerPositionSkewWarning } from '../packages/course/builder/src/index.ts'
import { createDeepSeekToolClient } from '../packages/host/chat-service/src/adapter.ts'

const sourceWs = process.argv[2]
if (sourceWs === undefined) throw new Error('用法：npx tsx scripts/_dbg_gen_quality.ts <已配置的工作区路径>')

const tempWs = await mkdtemp(join(tmpdir(), 'studyclaw-gen-quality-'))
await mkdir(join(tempWs, '.studyclaw'), { recursive: true })
// 复用源工作区的 provider/模型/密钥引用配置（密文凭据 + 用户级 master.key 可解密）
await writeFile(join(tempWs, '.studyclaw', 'config.yaml'), await readFile(join(sourceWs, '.studyclaw', 'config.yaml'), 'utf8'))
try { await writeFile(join(tempWs, '.studyclaw', 'credentials.json'), await readFile(join(sourceWs, '.studyclaw', 'credentials.json'), 'utf8')) } catch {}
await writeFile(join(tempWs, 'doc.md'), [
  '# Agent Harness 讲义（节选）',
  '',
  '## 闭环机制',
  'Agent Harness 闭环：模型决定下一步做什么并产出 tool_use；Harness 校验权限（这是 Harness 自己的环节，不是外部审计系统），按策略执行工具，把结果作为 tool_result 写回消息历史；模型在下一轮基于完整历史继续决策。',
  '',
  '## 上下文管理',
  'Harness 负责组织上下文窗口：裁剪过旧轮次、注入系统提示与记忆池，保证模型每轮看到的是有效信息而非原始堆积。上下文超限时优先丢弃最旧的工具输出而非系统规则。',
].join('\n'), 'utf8')

const config = await loadChatConfig(tempWs)
const client = createDeepSeekToolClient(config)
const generator = new LlmTaskGenerator(client, { model: config.model, provider: config.providerId || 'studyclaw', temperature: 0.4 })

const chunk = {
  chunk_id: 'chunk_001', chapter_id: 'chap_001', concept_id: 'c_loop',
  title: '闭环机制', content: 'Agent Harness 闭环：模型决定下一步做什么并产出 tool_use；Harness 校验权限（这是 Harness 自己的环节，不是外部审计系统），按策略执行工具，把结果作为 tool_result 写回消息历史；模型在下一轮基于完整历史继续决策。',
  source_ref: { file: 'doc.md', chunk_id: 'chunk_001' },
}
const targets = generationTargets(3, 0)
console.log('生成规格:', targets.map(t => `${t.type}/d${t.difficulty}/ans${t.answerPosition}`).join('  '))
const t0 = Date.now()
const cards = await generator.generateTasks(chunk, 3)
console.log('生成耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's')

const gate = enforceTaskQuality(cards)
console.log('质量闸: kept', gate.kept.length, '| dropped', JSON.stringify(gate.dropped))
console.log('偏斜告警:', answerPositionSkewWarning(gate.answerPositionHistogram) ?? '无')
for (const card of gate.kept) {
  const lens = (card.options ?? []).map(o => `${o.length}字`)
  console.log(`\n[${card.type}/d${card.difficulty}] ${card.question}`)
  console.log('  answer_index:', card.answer_index, '| 选项字数:', lens.join(','))
  for (const [i, option] of (card.options ?? []).entries()) console.log(`   ${String.fromCharCode(65 + i)}. ${option.slice(0, 46)}`)
  console.log('  rationale:', (card.answer_rationale ?? '').slice(0, 60))
}
await rm(tempWs, { recursive: true, force: true })
