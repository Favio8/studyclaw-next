/**
 * L1~L3 风格联动：极速冲刺首轮注入薄弱点速览（quick + firstTurn）、
 * 其余风格/次轮不注入、feynman 提示词包含 write_note 沉淀指令。
 *
 * 断言口径：FakeLlm 收到的 system / 最后一条 user 消息（即模型可见的
 * 组装 prompt），与 prompt/assembled 事件同源。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TutorSession, type ToolCall, type ToolLlmClient } from '../src/session.ts'
import { defaultToolRegistry } from '@studyclaw/tools'

class RecordingLlm implements ToolLlmClient {
  readonly prompts: Array<{ system: string; messages: Array<Record<string, unknown>> }> = []

  async *request(
    system: string,
    messages: Array<Record<string, unknown>>,
    _tools: Array<Record<string, unknown>> | null,
  ): AsyncGenerator<{ kind: 'text'; delta: string }> {
    this.prompts.push({ system, messages })
    yield { kind: 'text', delta: '好，继续。' }
  }

  /** 第 index 次请求的用户消息正文（模型可见的 user prompt）。 */
  userPrompt(index = 0): string {
    const messages = this.prompts[index]?.messages ?? []
    const last = messages[messages.length - 1]
    return String(last?.['content'] ?? '')
  }

  systemPrompt(index = 0): string {
    return this.prompts[index]?.system ?? ''
  }
}

async function seedCourse(root: string): Promise<{ courseDir: string; wsRoot: string }> {
  const wsRoot = join(root, 'workspace')
  const courseDir = wsRoot
  await mkdir(join(wsRoot, '.studyclaw'), { recursive: true })
  await writeFile(join(courseDir, 'syllabus.json'), JSON.stringify({
    course_id: 'c1', title: 'Java 基础', version: '1.0.0',
    chapters: [{
      id: 'chap_1', title: '继承',
      concepts: [{ id: 'c_1', name: '重载与覆写' }, { id: 'c_2', name: '接口与抽象类' }],
    }],
  }), 'utf8')
  // c_1：掌握度 30%（<40% 薄弱）且复习日已过（到期）→ 必进薄弱点速览；
  // c_2：掌握度 85% 且远期排期 → 两条都不命中，作为反向对照。
  await writeFile(join(courseDir, 'progress.md'), [
    '# 学习进度', '',
    '- **总体掌握度**：30%', '- **待复习卡片数**：1', '- **最后更新时间**：2026-08-20 10:00', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| c_1 | 重载与覆写 | 继承 | 30% | 3 | 33% | 2.5 | 2026-08-25 | none | 0 |',
    '| c_2 | 接口与抽象类 | 继承 | 85% | 2 | 100% | 2.6 | 2099-01-01 | none | 2 |', '',
  ].join('\n'), 'utf8')
  await writeFile(join(wsRoot, '.studyclaw', 'Agent.md'), '你是资深 Java 导师。', 'utf8')
  return { courseDir, wsRoot }
}

async function setup(): Promise<{ root: string; courseDir: string; wsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-style-'))
  const seeded = await seedCourse(root)
  return { root, ...seeded }
}

function makeSession(courseDir: string, wsRoot: string, fake: RecordingLlm, mode: 'socratic' | 'quick' | 'feynman' | 'debug') {
  return new TutorSession(courseDir, wsRoot, {
    toolRegistry: defaultToolRegistry(courseDir, wsRoot),
    toolClientFactory: () => fake,
    nowFactory: () => new Date('2026-08-21T12:00:00Z'),
    new: true,
    mode,
  })
}

describe('风格联动（L1~L3）', () => {
  it('quick 首轮注入薄弱点速览：到期+低掌握度的 c_1 在列，健康的 c_2 不在列', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const fake = new RecordingLlm()
    const session = makeSession(courseDir, wsRoot, fake, 'quick')
    await session.init()
    for await (const _event of session.chatEvents('下周考试，帮我划重点')) void _event

    const user = fake.userPrompt()
    expect(user).toContain('薄弱点速览')
    expect(user).toContain('c_1')
    expect(user).toContain('重载与覆写')
    expect(user).toContain('到期 2026-08-25')
    expect(user).not.toContain('c_2')
    await rm(root, { recursive: true, force: true })
  })

  it('quick 次轮不再注入（首轮判定基于有无历史消息）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const fake = new RecordingLlm()
    const session = makeSession(courseDir, wsRoot, fake, 'quick')
    await session.init()
    for await (const _event of session.chatEvents('第一问')) void _event
    for await (const _event of session.chatEvents('第二问')) void _event

    expect(fake.userPrompt(0)).toContain('薄弱点速览')
    expect(fake.userPrompt(1)).not.toContain('薄弱点速览')
    await rm(root, { recursive: true, force: true })
  })

  it('socratic 首轮不注入薄弱点速览（仅 quick 触发）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const fake = new RecordingLlm()
    const session = makeSession(courseDir, wsRoot, fake, 'socratic')
    await session.init()
    for await (const _event of session.chatEvents('什么是覆写？')) void _event

    expect(fake.userPrompt()).not.toContain('薄弱点速览')
    await rm(root, { recursive: true, force: true })
  })

  it('feynman 系统提示包含 write_note 沉淀指令（L2）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const fake = new RecordingLlm()
    const session = makeSession(courseDir, wsRoot, fake, 'feynman')
    await session.init()
    for await (const _event of session.chatEvents('我给你讲一下覆写')) void _event

    expect(fake.systemPrompt()).toContain('write_note')
    await rm(root, { recursive: true, force: true })
  })
})
