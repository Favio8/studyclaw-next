import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ denyRead: false, denyBackup: false, missingStat: '' }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error('INJECTED ACCESS DENIED'), { code: 'EACCES' })
  return { ...actual,
    readFile: (path: unknown, ...args: unknown[]) => {
      if (fault.denyRead && String(path).endsWith('.events.jsonl')) return Promise.reject(denied())
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...args)
    },
    writeFile: (path: unknown, ...args: unknown[]) => {
      if (fault.denyBackup && String(path).includes('.corrupt-')) return Promise.reject(denied())
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...args)
    },
    stat: (path: unknown, ...args: unknown[]) => {
      if (String(path) === fault.missingStat) return Promise.reject(Object.assign(new Error('fixture stat miss'), { code: 'ENOENT' }))
      return (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...args)
    },
  }
})
import { SessionEventStore } from '../src/events.ts'
import { SessionStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { fault.denyRead = false; fault.denyBackup = false; fault.missingStat = ''; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const event = { ts: '2026-10-11T00:00:00Z', type: 'user/input', payload: { content: 'FIXTURE' } }
async function root() { const path = await mkdtemp(join(tmpdir(), 'studyclaw-session-integrity-')); roots.push(path); return path }

describe('会话写入不能误覆盖历史', () => {
  it('读取失败不等于新日志，拒绝追加并保留原内容', async () => {
    const store = new SessionEventStore(await root())
    const raw = JSON.stringify({ ...event, seq: 1 }) + '\n'
    await writeFile(store.pathFor('s'), raw)
    fault.denyRead = true
    await expect(store.append('s', event)).rejects.toMatchObject({ code: 'EACCES' })
    fault.denyRead = false
    expect(await readFile(store.pathFor('s'), 'utf8')).toBe(raw)
  })

  it('损坏历史备份失败时禁止截断重写', async () => {
    const store = new SessionEventStore(await root())
    const raw = JSON.stringify({ ...event, seq: 1 }) + '\n{ damaged tail'
    await writeFile(store.pathFor('s'), raw)
    fault.denyBackup = true
    await expect(store.append('s', event)).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(store.pathFor('s'), 'utf8')).toBe(raw)
  })

  it('两个并发同秒会话只能有一个创建成功，不能覆盖另一份元数据', async () => {
    const store = new SessionStore(await root())
    fault.missingStat = store.pathFor('20261011-000000')
    const now = new Date('2026-10-11T00:00:00Z')
    const results = await Promise.allSettled([store.newSession('socratic', 'A', now), store.newSession('quick', 'B', now)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('并发归档两份旧会话不能丢掉其中一条归档记录', async () => {
    const store = new SessionStore(await root())
    const a = await store.newSession('socratic', 'A', new Date('2026-10-11T00:00:00Z'))
    const b = await store.newSession('socratic', 'B', new Date('2026-10-11T00:00:01Z'))
    await Promise.all([store.archiveSession(a.sessionId), store.archiveSession(b.sessionId)])
    expect(await store.listSessions()).toEqual([])
  })

  it('并发手动排序按请求顺序落盘，临时文件和快照不能互相覆盖', async () => {
    const dir = await root(), store = new SessionStore(dir)
    const ids: string[] = []
    for (let index = 0; index < 3; index++) ids.push((await store.newSession('socratic', String(index), new Date(`2026-10-11T00:00:0${index}Z`))).sessionId)
    await writeFile(join(dir, '.session-order.json'), JSON.stringify(ids))
    await Promise.all([store.insertSessionBefore(ids[2]!, ids[0]!), store.insertSessionBefore(ids[1]!, ids[2]!)])
    expect((await store.listSessions()).map(item => item.id)).toEqual([ids[1], ids[2], ids[0]])
  })
});
