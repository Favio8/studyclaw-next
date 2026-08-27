import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionEventStore, SessionStore, utcTs, studyclawFallbackTitle, normalizeSessionTitle } from '../src/index.ts'

describe('title normalization (dsh normalize port)', () => {
  it('derives a CJK-safe fallback within the word/byte caps', () => {
    expect(studyclawFallbackTitle('帮我复习一下线性代数第三章的特征值分解')).toBe('帮我复习一下线性代数第三章')
    expect(studyclawFallbackTitle('review chapter 3 eigenvalue decomposition today')).toBe('review chapter 3 eigenvalue decompositio')
    expect(studyclawFallbackTitle('   ')).toBe('')
  })

  it('strips terminal escapes and invisible controls', () => {
    const dirty = 'a' + String.fromCharCode(0x1b) + '[31mred' + String.fromCharCode(0x1b) + ']0;title' + String.fromCharCode(0x07) + ' b' + String.fromCharCode(0x200b) + ' c'
    expect(normalizeSessionTitle(dirty, 80)).toBe('ared b c')
    expect(normalizeSessionTitle('反转' + String.fromCharCode(0x202e) + '测试', 80)).toBe('反转测试')
  })
})

describe('SessionStore.applyAutoTitle (DSH title semantics)', () => {
  it('writes the fallback once, upgrades with llm, and pins after a user rename', async () => {
    const historyDir = await mkdtemp(join(tmpdir(), 'studyclaw-title-store-'))
    try {
      const store = new SessionStore(historyDir)
      const events = new SessionEventStore(historyDir)
      const { sessionId } = await store.newSession('socratic', null)
      await events.append(sessionId, { ts: utcTs(), type: 'session/create', payload: { mode: 'socratic' } })

      // 1) 首条消息：fallback 落盘，列表立即显示。
      expect(await store.applyAutoTitle(sessionId, studyclawFallbackTitle('帮我复习线性代数第三章'), 'fallback')).toBe(true)
      expect((await store.listSessions()).find(s => s.id === sessionId)?.title).toBe('帮我复习线性代数第三章')

      // 2) fallback 只写一次（第二轮发送不再覆盖）。
      expect(await store.applyAutoTitle(sessionId, '第二轮消息截断', 'fallback')).toBe(false)

      // 3) LLM 标题升级 fallback。
      expect(await store.applyAutoTitle(sessionId, '线性代数复习', 'llm', { provider: 'my-gateway', model: 'm' })).toBe(true)
      expect((await store.listSessions()).find(s => s.id === sessionId)?.title).toBe('线性代数复习')

      // 4) LLM 升级也只发生一次。
      expect(await store.applyAutoTitle(sessionId, '另一个标题', 'llm', { provider: 'my-gateway', model: 'm' })).toBe(false)

      // 5) 用户重命名后 pin：自动标题彻底失效。
      await store.renameSession(sessionId, '我的期末复习')
      expect(await store.applyAutoTitle(sessionId, 'late llm title', 'llm', { provider: 'my-gateway', model: 'm' })).toBe(false)
      expect((await store.listSessions()).find(s => s.id === sessionId)?.title).toBe('我的期末复习')
    } finally {
      await rm(historyDir, { recursive: true, force: true })
    }
  })

  it('keeps the legacy first-user-input derivation for sessions without title events', async () => {
    const historyDir = await mkdtemp(join(tmpdir(), 'studyclaw-title-legacy-'))
    try {
      const store = new SessionStore(historyDir)
      const events = new SessionEventStore(historyDir)
      const { sessionId } = await store.newSession('socratic', null)
      await events.append(sessionId, { ts: utcTs(), type: 'session/create', payload: { mode: 'socratic' } })
      await events.append(sessionId, { ts: utcTs(), type: 'user/input', payload: { content: '旧版本会话的第一条消息' } })
      const listed = (await store.listSessions()).find(s => s.id === sessionId)
      expect(listed?.title).toBe('旧版本会话的第一条消息')
    } finally {
      await rm(historyDir, { recursive: true, force: true })
    }
  })
})
