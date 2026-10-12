/**
 * 桌面壳启动失败误报回归（用户长期反馈的 ERR_ABORTED 弹窗）。
 *
 * `win.loadURL` 的 Promise 在「导航被更新导航取代 / 页面自导航 / 菜单 reload /
 * 应用退出中」时都会以 ERR_ABORTED 拒绝；这些不是启动失败，不能弹窗退出应用。
 * 只有窗口始终没有加载出页面（等待 did-finish-load 超时）才按真实失败上报。
 */

import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { loadWindowUrl } = require('../src/window-load.cjs') as {
  loadWindowUrl: (
    win: unknown,
    url: string,
    state?: { isSuperseded?: () => boolean; isQuitting?: () => boolean; abortGraceMs?: number },
  ) => Promise<{ ok: boolean; error?: unknown }>
}

function aborted(): Error {
  return new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:65139/'")
}

function fakeWin(options: {
  load?: () => Promise<unknown>
  destroyed?: boolean
  /** 触发 did-finish-load 的延迟；undefined = 永不触发。 */
  finishAfterMs?: number
}) {
  const once = vi.fn((event: string, callback: () => void) => {
    if (event === 'did-finish-load' && options.finishAfterMs !== undefined) {
      setTimeout(callback, options.finishAfterMs)
    }
  })
  return {
    loadURL: options.load ?? (() => Promise.resolve()),
    isDestroyed: () => options.destroyed === true,
    webContents: { once },
  }
}

describe('loadWindowUrl', () => {
  it('正常加载返回 ok', async () => {
    const result = await loadWindowUrl(fakeWin({ load: () => Promise.resolve() }), 'http://127.0.0.1:1/')
    expect(result.ok).toBe(true)
  })

  it('真实连接错误（非中止）按失败上报', async () => {
    const result = await loadWindowUrl(fakeWin({ load: () => Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)')) }), 'http://127.0.0.1:1/')
    expect(result.ok).toBe(false)
  })

  it('ERR_ABORTED 但窗口随后加载完成：不算失败（不弹窗）', async () => {
    const win = fakeWin({ load: () => Promise.reject(aborted()), finishAfterMs: 10 })
    const result = await loadWindowUrl(win, 'http://127.0.0.1:1/', { abortGraceMs: 200 })
    expect(result.ok).toBe(true)
  })

  it('ERR_ABORTED 且始终没有页面加载：按真实失败上报', async () => {
    const win = fakeWin({ load: () => Promise.reject(aborted()) })
    const result = await loadWindowUrl(win, 'http://127.0.0.1:1/', { abortGraceMs: 30 })
    expect(result.ok).toBe(false)
  })

  it('加载已被更新的导航取代：忽略中止', async () => {
    const win = fakeWin({ load: () => Promise.reject(aborted()) })
    const result = await loadWindowUrl(win, 'http://127.0.0.1:1/', { isSuperseded: () => true })
    expect(result.ok).toBe(true)
  })

  it('应用退出中或窗口已销毁：忽略中止', async () => {
    const quitting = await loadWindowUrl(fakeWin({ load: () => Promise.reject(aborted()) }), 'http://127.0.0.1:1/', { isQuitting: () => true })
    expect(quitting.ok).toBe(true)
    const destroyed = await loadWindowUrl(fakeWin({ load: () => Promise.reject(aborted()), destroyed: true }), 'http://127.0.0.1:1/')
    expect(destroyed.ok).toBe(true)
  })
})
