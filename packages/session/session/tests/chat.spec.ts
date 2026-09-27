/**
 * Chat-loop e2e against a fake LLM client: full turn flow (context render →
 * tool loop → split → persist → restore), the ask-question short-circuit,
 * sync application to progress.md, and turn resume.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TutorSession, type ToolCall, type ToolLlmClient } from '../src/session.ts'
import { defaultToolRegistry } from '@studyclaw/tools'
import { SessionStore, utcTs } from '../src/store.ts'
import { SessionEventStore } from '../src/events.ts'

interface FakeScript {
  readonly rounds: Array<{
    text?: string
    calls?: ToolCall[]
  }>
}

class FakeLlmClient implements ToolLlmClient {
  readonly received: Array<Array<Record<string, unknown>>> = []

  constructor(private readonly script: FakeScript) {}

  async *request(
    _system: string,
    messages: Array<Record<string, unknown>>,
    _tools: Array<Record<string, unknown>> | null,
  ): AsyncGenerator<{ kind: 'text'; delta: string } | { kind: 'toolCalls'; calls: ToolCall[] }> {
    this.received.push(messages)
    for (const round of this.script.rounds) {
      if (round.text !== undefined) yield { kind: 'text', delta: round.text }
      if (round.calls !== undefined) yield { kind: 'toolCalls', calls: round.calls }
    }
  }
}

async function seedCourse(root: string): Promise<{ courseDir: string; wsRoot: string }> {
  const wsRoot = join(root, 'workspace')
  // 项目即课程：状态/资料就地位于项目根。
  const courseDir = wsRoot
  await mkdir(join(wsRoot, '.studyclaw'), { recursive: true })
  await writeFile(join(courseDir, 'syllabus.json'), JSON.stringify({
    course_id: 'c1', title: '多态基础', version: '1.0.0',
    chapters: [{ id: 'chap_1', title: '继承', concepts: [{ id: 'c_1', name: '重载与覆写' }] }],
  }), 'utf8')
  await writeFile(join(courseDir, 'progress.md'), [
    '# 学习进度', '',
    '- **总体掌握度**：30%', '- **待复习卡片数**：0', '- **最后更新时间**：2026-08-20 10:00', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution |',
    '|---|---|---|---|---|---|---|---|---|',
    '| c_1 | 重载与覆写 | 继承 | 30% | 1 | 0% | 2.5 | 2026-08-25 | none |', '',
  ].join('\n'), 'utf8')
  await writeFile(join(wsRoot, '.studyclaw', 'Agent.md'), '你是资深 Java 导师。', 'utf8')
  await writeFile(join(wsRoot, '.studyclaw', 'Memory.md'), '学生擅长 K8s，对 OOP 抽象薄弱。', 'utf8')
  await writeFile(join(courseDir, 'overview.md'), '# 多态\n\n## 重载与覆写\n\n重载是同一类中同名不同参数；覆写是子类重定义父类方法。\n', 'utf8')
  return { courseDir, wsRoot }
}

async function setup(): Promise<{ root: string; courseDir: string; wsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-chat-'))
  const seeded = await seedCourse(root)
  return { root, ...seeded }
}

function makeSession(courseDir: string, wsRoot: string, script: FakeScript, options: ConstructorParameters<typeof TutorSession>[2] = {}) {
  const registry = defaultToolRegistry(courseDir, wsRoot)
  return new TutorSession(courseDir, wsRoot, {
    toolRegistry: registry,
    toolClientFactory: () => new FakeLlmClient(script),
    nowFactory: () => new Date('2026-08-21T12:00:00Z'),
    ...options,
  })
}

describe('TutorSession chat loop', () => {
  it('streams a plain turn and persists user+agent lines', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const session = makeSession(courseDir, wsRoot, {
      rounds: [{ text: '<think>先想一下。</think>答案是覆写。' }],
    }, { new: true, mode: 'socratic' })
    await session.init()

    const events: string[] = []
    for await (const event of session.chatEvents('什么是覆写？')) {
      events.push(`${event.kind}:${'delta' in event ? event.delta : ''}`)
    }
    expect(events).toContain('thinking:先想一下。')
    expect(events).toContain('token:答案是覆写。')
    expect(events.some(e => e.startsWith('sync:'))).toBe(false)

    const store = new SessionStore(join(courseDir, 'history'))
    const chats = await store.loadChat(session.sessionId)
    expect(chats.map(c => c.content)).toEqual(['什么是覆写？', '答案是覆写。'])
    expect((await store.readMeta(session.sessionId))?.title).toBe('什么是覆写？')
    await rm(root, { recursive: true, force: true })
  })

  it('runs the tool loop and feeds results back; ask_user_question ends the turn', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const session = makeSession(courseDir, wsRoot, {
      rounds: [
        { calls: [{ id: 'call_1', name: 'read_source', arguments: { path: 'overview.md' } }] },
        { text: '资料里说了：重载与覆写的关键区别。' },
      ],
    }, { new: true, mode: 'socratic' })
    await session.init()

    const events = []
    for await (const event of session.chatEvents('解释一下')) events.push(event)
    expect(events.some(e => e.kind === 'tool' && e.payload['name'] === 'read_source' && e.payload['status'] === 'success')).toBe(true)
    const visible = events.filter(e => e.kind === 'token').map(e => e.delta).join('')
    expect(visible).toContain('关键区别')
    await rm(root, { recursive: true, force: true })
  })

  it('ask_user_question produces a pending ask line and resumes on the next turn', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const askScript = { rounds: [{ calls: [{ id: 'call_1', name: 'ask_user_question', arguments: { question: '你先说说你的理解？' } }] }] }
    const session = makeSession(courseDir, wsRoot, askScript, { new: true, mode: 'socratic' })
    await session.init()

    const events = []
    for await (const event of session.chatEvents('我想学多态')) events.push(event)
    expect(events.some(e => e.kind === 'ask' && e.question === '你先说说你的理解？')).toBe(true)

    const store = new SessionStore(join(courseDir, 'history'))
    const rows = await store.load(session.sessionId)
    const asks = rows.filter(row => row['type'] === 'ask')
    expect(asks).toHaveLength(1)
    expect(asks[0]!['status']).toBe('pending')

    // Next turn: the pending question feeds back as assistant context; the
    // answer records an answered ask line before the new pending one.
    const answerSession = makeSession(courseDir, wsRoot, { rounds: [{ text: '好的回答。' }] }, { sessionId: session.sessionId, mode: 'socratic' })
    await answerSession.init()
    const events2 = []
    for await (const event of answerSession.chatEvents('我的理解是 A 和 B')) events2.push(event)
    const rows2 = await store.load(session.sessionId)
    const asks2 = rows2.filter(row => row['type'] === 'ask')
    // Append-only file order: turn-1 pending line first, turn-2 answered line second.
    expect(asks2).toHaveLength(2)
    expect(asks2[0]!['status']).toBe('pending')
    expect(asks2[1]!['status']).toBe('answered')
    expect(asks2[1]!['answer']).toBe('我的理解是 A 和 B')
    await rm(root, { recursive: true, force: true })
  })

  it('writes ask/answered in the event log before a resumed model step', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const eventStore = new SessionEventStore(join(courseDir, 'history'))
    const first = makeSession(courseDir, wsRoot, { rounds: [{ text: '回答' }] }, {
      new: true,
      mode: 'socratic',
      persistLegacy: false,
      eventStore,
    })
    await first.init()
    await eventStore.append(first.sessionId, { ts: utcTs(), type: 'ask/pending', payload: { question: '继续吗？' } })
    for await (const _ of first.chatEvents('继续')) { /* consume */ }
    const rows = await eventStore.load(first.sessionId)
    expect(rows.some(row => row.type === 'ask/answered' && row.payload['answer'] === '继续')).toBe(true)
    expect((await eventStore.project(first.sessionId)).pendingAsk).toBeNull()
    await rm(root, { recursive: true, force: true })
  })

  it('applies the sync payload to progress.md and emits a sync event', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const session = makeSession(courseDir, wsRoot, {
      rounds: [{
        text: `讲解完成。${'[STUDYCLAW_SYNC]'}{"_studyclaw_sync":{"concept_updates":[{"id":"c_1","score":0.7}],"memory_hints":["混淆了重载与覆写"],"changelog":"+ 攻克覆写"}}`,
      }],
    }, { new: true, mode: 'socratic' })
    await session.init()

    const events = []
    for await (const event of session.chatEvents('继续')) events.push(event)
    const syncEvent = events.find(e => e.kind === 'sync')
    expect(syncEvent).toBeDefined()

    const progress = await readFile(join(courseDir, 'progress.md'), 'utf8')
    // 单元格重排后仅断言关键内容（70% 掌握度 + 概念行仍在）
    const c1Row = progress.split(/\r?\n/).find(line => line.includes('c_1') && line.includes('重载与覆写'))
    expect(c1Row).toBeDefined()
    expect(c1Row).toContain('70%')
    const store = new SessionStore(join(courseDir, 'history'))
    const rows = await store.load(session.sessionId)
    expect(rows.some(row => row['type'] === 'sync' && row['target'] === 'progress.md')).toBe(true)
    expect(rows.some(row => row['type'] === 'sync' && row['target'] === 'memory_pool')).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('RV-12：sync 回写经注入的 courseLock（与 eval 的 SM-2 RMW 串行，不再锁外竞争）', async () => {
    const { root, courseDir, wsRoot } = await setup()
    let lockCalls = 0
    const session = makeSession(courseDir, wsRoot, {
      rounds: [{
        text: `讲解完成。${'[STUDYCLAW_SYNC]'}{"_studyclaw_sync":{"concept_updates":[{"id":"c_1","score":0.7}],"memory_hints":[],"changelog":"+ 攻克覆写"}}`,
      }],
    }, {
      new: true,
      mode: 'socratic',
      courseLock: async <T,>(fn: () => Promise<T>): Promise<T> => {
        lockCalls += 1
        return await fn()
      },
    })
    await session.init()

    const events = []
    for await (const event of session.chatEvents('继续')) events.push(event)
    expect(events.some(event => event.kind === 'sync')).toBe(true)
    // 写段必须走锁（宿主侧注入的是 withCourseLock）。
    expect(lockCalls).toBe(1)
    const progress = await readFile(join(courseDir, 'progress.md'), 'utf8')
    expect(progress).toContain('70%')
    await rm(root, { recursive: true, force: true })
  })

  it('restores an existing session with its history', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const first = makeSession(courseDir, wsRoot, { rounds: [{ text: '第一轮回答。' }] }, { new: true })
    await first.init()
    for await (const _ of first.chatEvents('第一问')) { /* consume */ }

    const resumed = makeSession(courseDir, wsRoot, { rounds: [{ text: '第二轮回答。' }] }, { sessionId: first.sessionId })
    await resumed.init()
    const history = await resumed.history()
    expect(history.map(c => c.content)).toEqual(['第一问', '第一轮回答。'])
    for await (const _ of resumed.chatEvents('第二问')) { /* consume */ }
    const history2 = await resumed.history()
    expect(history2.map(c => c.content)).toEqual(['第一问', '第一轮回答。', '第二问', '第二轮回答。'])
    await rm(root, { recursive: true, force: true })
  })

  // 网关会在任何含 `<script>(...)` 的请求上毫秒级断连；完整交互演示块必然
  // 命中。落盘保留全量块（UI 渲染），模型回放只见占位行。
  const interactiveReply = [
    '看这个演示。', '',
    '```sc-interactive',
    '<title>演示甲</title>',
    '<script>(function () { document.body.textContent = "hi" })()</script>',
    '```', '',
    '以上是演示。',
  ].join('\n')

  function replayedAssistant(client: FakeLlmClient): string {
    const request = client.received[client.received.length - 1]!
    const assistant = request.filter(message => message['role'] === 'assistant')
    expect(assistant).toHaveLength(1)
    return String(assistant[0]!['content'])
  }

  it('elides closed sc-interactive bodies from replayed history (legacy store)', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const first = makeSession(courseDir, wsRoot, { rounds: [{ text: interactiveReply }] }, { new: true })
    await first.init()
    for await (const _ of first.chatEvents('给我一个演示')) { /* consume */ }

    const persisted = await new SessionStore(join(courseDir, 'history')).loadChat(first.sessionId)
    expect(persisted[1]!.content).toContain('<script>')

    const client = new FakeLlmClient({ rounds: [{ text: '第二轮。' }] })
    const resumed = new TutorSession(courseDir, wsRoot, {
      sessionId: first.sessionId,
      toolRegistry: defaultToolRegistry(courseDir, wsRoot),
      toolClientFactory: () => client,
    })
    await resumed.init()
    for await (const _ of resumed.chatEvents('继续')) { /* consume */ }

    const replayed = replayedAssistant(client)
    expect(replayed).not.toContain('<script>')
    expect(replayed).toContain('```sc-interactive')
    expect(replayed).toContain('已被系统省略（演示甲）')
    expect(replayed).toContain('看这个演示。')
    await rm(root, { recursive: true, force: true })
  })

  it('elides closed sc-interactive bodies from replayed history (event log)', async () => {
    const { root, courseDir, wsRoot } = await setup()
    const eventStore = new SessionEventStore(join(courseDir, 'history'))
    const first = makeSession(courseDir, wsRoot, { rounds: [{ text: interactiveReply }] }, {
      new: true, persistLegacy: false, eventStore,
    })
    await first.init()
    // 事件持久化由宿主 AgentLoop 负责：送前写 user/input，收完写 assistant/message。
    await eventStore.append(first.sessionId, { ts: utcTs(), type: 'user/input', payload: { content: '给我一个演示' } })
    for await (const _ of first.chatEvents('给我一个演示')) { /* consume */ }
    await eventStore.append(first.sessionId, { ts: utcTs(), type: 'assistant/message', payload: { content: interactiveReply, provider: 'fake' } })

    const projection = await eventStore.project(first.sessionId)
    expect(projection.messages.map(message => message.content)[1]).toContain('<script>')

    const client = new FakeLlmClient({ rounds: [{ text: '第二轮。' }] })
    const resumed = new TutorSession(courseDir, wsRoot, {
      sessionId: first.sessionId,
      persistLegacy: false,
      eventStore,
      toolRegistry: defaultToolRegistry(courseDir, wsRoot),
      toolClientFactory: () => client,
    })
    await resumed.init()
    for await (const _ of resumed.chatEvents('继续')) { /* consume */ }

    const replayed = replayedAssistant(client)
    expect(replayed).not.toContain('<script>')
    expect(replayed).toContain('已被系统省略（演示甲）')
    await rm(root, { recursive: true, force: true })
  })

  it('init 优先事件日志：运行时子 Agent 的不透明 id 不被 legacy 正则拒绝（H1）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-chat-child-'))
    const { courseDir, wsRoot } = await seedCourse(root)
    const eventStore = new SessionEventStore(join(courseDir, 'history'))
    // createLearningAgent 的子会话 id 形如 `<parent>-child-<ts>`，不满足
    // legacy SessionStore 的 `YYYYMMDD-HHMMSS` 校验；只要事件流存在即有效。
    const childId = `20260907-120000-child-ab12cd34`
    await eventStore.append(childId, { ts: utcTs(), type: 'session/create', payload: { mode: 'debug' } })
    const session = new TutorSession(courseDir, wsRoot, {
      sessionId: childId,
      persistLegacy: false,
      eventStore,
      toolRegistry: defaultToolRegistry(courseDir, wsRoot),
      toolClientFactory: () => new FakeLlmClient({ rounds: [{ text: '子代理回复。' }] }),
    })
    await session.init()
    expect(session.sessionId).toBe(childId)
    // 事件流路径下 assistant/message 由宿主 AgentLoop 落盘；这里断言回合
    // 能正常跑完并流式产出正文（修复前 init 直接抛「非法会话 ID」）。
    let streamed = ''
    for await (const event of session.chatEvents('排查这个报错')) {
      if (event.kind === 'token') streamed += event.delta
    }
    expect(streamed).toContain('子代理回复')
    await rm(root, { recursive: true, force: true })
  })
})
