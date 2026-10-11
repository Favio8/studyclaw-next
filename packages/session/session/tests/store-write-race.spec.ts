/**
 * 会话文件的 append 与 meta 重写必须互斥。
 *
 * 回归场景：meta 重写（改名 / 标题回填）是「读全量 → 改首行 → 写 tmp →
 * rename」。rename 用的是改前读到的快照，因此落在这两步之间的追加会被
 * 整体覆盖掉——用户在 Agent 流式写入中途改会话名，就可能有一条消息
 * 凭空消失。修复前实测 60 轮并发里丢 2 条。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/store.ts'
import { chatLine } from '../src/models.ts'

async function setup(): Promise<{ root: string; store: SessionStore; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-session-race-'))
  const store = new SessionStore(join(root, 'history'))
  const { sessionId } = await store.newSession('socratic', null, new Date('2026-08-21T10:00:00Z'))
  return { root, store, sessionId }
}

describe('SessionStore 写并发', () => {
  it('append 与改名并发时不丢行', async () => {
    const { root, store, sessionId } = await setup()
    try {
      const markers = Array.from({ length: 60 }, (_, i) => `marker-${i}`)
      for (const marker of markers) {
        await Promise.all([
          store.append(sessionId, chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:00Z', role: 'user', content: marker })),
          store.renameSession(sessionId, `标题-${marker}`),
        ])
      }
      const contents = (await store.loadChat(sessionId)).map(line => line.content)
      const lost = markers.filter((marker) => !contents.includes(marker))
      expect(lost, `这些追加行被 meta 重写的 rename 覆盖了: ${lost.join(', ')}`).toEqual([])
      expect((await store.readMeta(sessionId))?.title).toBe(`标题-${markers[markers.length - 1]}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('大量并发写同一会话：不丢行、也不因句柄冲突报错（压测，检出为概率性）', async () => {
    const { root, store, sessionId } = await setup()
    try {
      // 无锁时这条同时踩两种失败：追加落在 rename 的读-改-写窗口里被旧快照
      // 覆盖（POSIX 静默丢失），或 append 打开的文件句柄与 Windows 上的
      // rename 冲突直接 EPERM。两种都断言掉。
      //
      // 检出率是概率性的（实测回退修复后约 4/5 命中）：竞态窗口只有一次
      // read-all 的宽度，把文件预置大只是把它拉宽，没有根除时序依赖。确定性地
      // 把追加塞进窗口需要往生产代码开口子（注入点），那比这个 bug 本身更糟。
      // 因此这条测试的保证是单向的——**有修复时永不失败**（实测 6/6 通过），
      // 回退修复时大概率变红。真正的保障是 append 与 meta 重写共用同一把按
      // 路径的锁，见 store.ts 的 withFileWriteLock 注释。
      const markers = Array.from({ length: 60 }, (_, i) => `m-${i}`)
      // 预置体积：meta 重写每次都要 read-all 一遍，文件越大这个窗口越宽，
      // 落在窗口内的追加就必然命中——把概率性检出变成稳定检出。
      const bulk = 12000
      await store.append(sessionId, ...Array.from({ length: bulk }, (_, i) =>
        chatLine.parse({ type: 'chat', ts: '2026-08-21T09:00:00Z', role: 'user', content: `bulk-${i}-${'x'.repeat(120)}` })))

      await expect(Promise.all([
        ...markers.map((marker, i) => store.append(sessionId,
          chatLine.parse({ type: 'chat', ts: `2026-08-21T10:00:${String(i % 60).padStart(2, '0')}Z`, role: 'user', content: marker }))),
        ...Array.from({ length: 20 }, (_, i) => store.renameSession(sessionId, `t-${i}`)),
      ])).resolves.toBeDefined()

      const contents = (await store.loadChat(sessionId)).map(line => line.content)
      const lost = markers.filter((marker) => !contents.includes(marker))
      expect(lost, `这些追加行被覆盖了: ${lost.join(', ')}`).toEqual([])
      // 预置的 bulk 行也必须完好：它们与 marker 走同一条写入路径。
      expect(contents.filter((c) => c.startsWith('bulk-'))).toHaveLength(bulk)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('并发的多个 append 全部保留、不重复', async () => {
    const { root, store, sessionId } = await setup()
    try {
      const markers = Array.from({ length: 40 }, (_, i) => `seq-${i}`)
      await Promise.all(markers.map((marker, i) =>
        store.append(sessionId, chatLine.parse({ type: 'chat', ts: `2026-08-21T10:00:${String(i).padStart(2, '0')}Z`, role: 'user', content: marker }))))

      const contents = (await store.loadChat(sessionId)).map(line => line.content)
      // 断言的是「不丢不重」，不是顺序：并发调用谁先抢到锁本就无保证
      //（每次 append 在入锁前还有一次 stat I/O），正常流程也不会并发写同一会话。
      expect([...contents].sort()).toEqual([...markers].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('标题回填与后续追加并发时，追加不丢且标题只回填一次', async () => {
    const { root, store, sessionId } = await setup()
    try {
      await Promise.all([
        store.fillDefaultTitle(sessionId, '第一条用户消息用于回填标题'),
        store.append(sessionId, chatLine.parse({ type: 'chat', ts: '2026-08-21T10:00:01Z', role: 'user', content: '并发写入的内容' })),
      ])
      const contents = (await store.loadChat(sessionId)).map(line => line.content)
      expect(contents).toContain('并发写入的内容')
      expect((await store.readMeta(sessionId))?.title).toBe('第一条用户消息用于回填标题')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})