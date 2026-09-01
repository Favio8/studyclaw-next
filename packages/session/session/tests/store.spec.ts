/**
 * SessionStore suite: create/list (mtime recency), append-only writes,
 * load/loadChat, meta title backfill, and the id whitelist guard.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, SessionError } from '../src/store.ts'
import { chatLine, toolLine } from '../src/models.ts'

async function setup(): Promise<{ root: string; store: SessionStore }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-session-store-'))
  return { root, store: new SessionStore(join(root, 'history')) }
}

describe('SessionStore', () => {
  it('creates a session with a meta first line and lists by mtime desc', async () => {
    const { store } = await setup()
    const first = await store.newSession('socratic', '第一轮', new Date('2026-08-21T10:00:00Z'))
    const second = await store.newSession('quick', null, new Date('2026-08-21T10:01:00Z'))

    expect(first.sessionId).toMatch(/^\d{8}-\d{6}$/)
    expect(first.sessionId).toBe('20260821-100000')
    const meta = await store.readMeta(first.sessionId)
    expect(meta?.title).toBe('第一轮')
    expect(meta?.mode).toBe('socratic')

    const listed = await store.listSessions()
    expect(listed[0]!.id).toBe(second.sessionId)
    expect(listed[1]!.id).toBe(first.sessionId)
    expect(listed[0]!.mode).toBe('quick')
  })

  it('tolerates an out-of-enum mode in the legacy meta line instead of failing the listing', async () => {
    const { root, store } = await setup()
    const { sessionId, path } = await store.newSession('socratic', '外部工具会话')
    const rows = (await readFile(path, 'utf8')).split(/\r?\n/)
    rows[0] = JSON.stringify({ type: 'session_meta', title: '外部工具会话', mode: 'tutor', created_at: '2026-08-21T10:00:00Z' })
    await writeFile(path, rows.join('\n'))

    const meta = await store.readMeta(sessionId)
    expect(meta).toMatchObject({ title: '外部工具会话', mode: 'socratic' })
    const listed = await store.listSessions()
    expect(listed.some(session => session.id === sessionId)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('appends chat lines and loads chat-only rows in order', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('socratic', '会话')
    await store.append(
      sessionId,
      chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:00Z', role: 'user', content: '你好' }),
      chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:01Z', role: 'agent', content: '我是导师', mode: 'socratic' }),
    )
    const chats = await store.loadChat(sessionId)
    expect(chats.map(c => c.content)).toEqual(['你好', '我是导师'])
  })

  it('backfills the title from the first user chat when empty', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('socratic', '')
    await store.fillDefaultTitle(sessionId, '这是一段超过二十个字符的用户消息内容用于标题回填')
    const meta = await store.readMeta(sessionId)
    expect(meta?.title).toBe('这是一段超过二十个字符的用户消息内容用于标题回填'.slice(0, 20))
    // 已有标题不再回填
    await store.fillDefaultTitle(sessionId, '再也不会')
    expect((await store.readMeta(sessionId))?.title).toBe('这是一段超过二十个字符的用户消息内容用于标题回填'.slice(0, 20))
  })

  it('rejects illegal session ids (path traversal) and unknown sessions', async () => {
    const { store } = await setup()
    expect(() => store.pathFor('../evil')).toThrow(SessionError)
    expect(() => store.pathFor('20260821-100000\nx')).toThrow(SessionError)
    await expect(store.load('20260821-100000')).rejects.toThrow(SessionError)
  })

  it('tolerates corrupt lines when loading', async () => {
    const { root, store } = await setup()
    const { sessionId } = await store.newSession('socratic', '')
    const path = store.pathFor(sessionId)
    await writeFile(path, '{"type":"session_meta","title":"","mode":"socratic","created_at":"2026-08-21T10:00:00Z"}\nnot-json{\n{"type":"chat","ts":"2026-08-21T10:00:00Z","role":"user","content":"x"}\n', 'utf8')
    const rows = await store.load(sessionId)
    expect(rows).toHaveLength(2)
    await rm(root, { recursive: true, force: true })
  })

  it('renames only metadata and preserves the append-only chat history', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('socratic', '旧标题')
    await store.append(sessionId, chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:00Z', role: 'user', content: '保留' }))
    const before = await store.load(sessionId)
    await store.renameSession(sessionId, '  新标题  ')
    expect((await store.readMeta(sessionId))?.title).toBe('新标题')
    expect(await store.load(sessionId)).toEqual(before.map((row, index) => index === 0 ? { ...row, title: '新标题' } : row))
  })

  it('forks a complete history with a new id and copy title', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('quick', '原会话', new Date('2026-08-21T10:00:00Z'))
    await store.append(sessionId, chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:01Z', role: 'user', content: '内容' }))
    const forked = await store.forkSession(sessionId, new Date('2026-08-21T10:01:00Z'))
    expect(forked.sessionId).toBe('20260821-100100')
    expect((await store.readMeta(forked.sessionId))?.title).toBe('原会话（副本）')
    expect((await store.loadChat(forked.sessionId)).map((line) => line.content)).toEqual(['内容'])
  })

  it('forks through one selected chat row and retains prior audit rows', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('quick', '原会话', new Date('2026-08-21T10:00:00Z'))
    await store.append(
      sessionId,
      chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:01Z', role: 'user', content: '问题一' }),
      toolLine.parse({ type: 'tool', ts: '2026-08-21T10:00:02Z', name: 'read_source', status: 'success', summary: '已读取' }),
      chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:03Z', role: 'agent', content: '回答一' }),
      chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:04Z', role: 'user', content: '问题二' }),
    )

    const forked = await store.forkSession(sessionId, new Date('2026-08-21T10:01:00Z'), 1)

    expect((await store.loadChat(forked.sessionId)).map((line) => line.content)).toEqual(['问题一', '回答一'])
    expect((await store.load(forked.sessionId)).map((line) => line.type)).toEqual(['session_meta', 'chat', 'tool', 'chat'])
  })

  it('archives a session without deleting it and filters it from listings', async () => {
    const { store } = await setup()
    const { sessionId } = await store.newSession('socratic', '待归档', new Date('2026-08-21T10:00:00Z'))
    expect((await store.listSessions()).map((item) => item.id)).toEqual([sessionId])
    await store.archiveSession(sessionId)
    expect(await store.listSessions()).toEqual([])
    expect((await store.readMeta(sessionId))?.title).toBe('待归档')
  })

  it('persists manual insertion, reconciles missing sessions, and removes archived ids', async () => {
    const { store } = await setup()
    const first = await store.newSession('socratic', '第一轮', new Date('2026-08-21T10:00:00Z'))
    const second = await store.newSession('quick', '第二轮', new Date('2026-08-21T10:01:00Z'))
    await store.insertSessionBefore(first.sessionId, second.sessionId)
    expect((await store.listSessions()).map((session) => session.id)).toEqual([first.sessionId, second.sessionId])

    const third = await store.newSession('feynman', '第三轮', new Date('2026-08-21T10:02:00Z'))
    expect((await store.listSessions()).map((session) => session.id)).toEqual([first.sessionId, second.sessionId, third.sessionId])
    expect(await store.latestSessionId()).toBe(third.sessionId)

    await rm(store.pathFor(second.sessionId))
    expect((await store.listSessions()).map((session) => session.id)).toEqual([first.sessionId, third.sessionId])
    expect(JSON.parse(await readFile(join(store.historyDir, '.session-order.json'), 'utf8'))).toEqual([first.sessionId, third.sessionId])

    await store.archiveSession(first.sessionId)
    expect((await store.listSessions()).map((session) => session.id)).toEqual([third.sessionId])
    expect(JSON.parse(await readFile(join(store.historyDir, '.session-order.json'), 'utf8'))).toEqual([third.sessionId])
  })
})
