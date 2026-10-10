/**
 * 进程级兜底：未处理的 Promise 拒绝不得带走宿主。
 *
 * Node >=15 默认 `unhandled-rejections=throw`，一个游离 rejection 会终止
 * 这个单进程 Host，连带所有打开的界面标签页。对本地单用户工具这是错的
 * 取舍：记录下来并继续，比整个服务消失好。
 *
 * 用例之间必须重载模块：安装是幂等的（模块级 `installed` 标志），否则第
 * 一个用例装过一次后，后面的安装都是 no-op、监听器又被 afterEach 清掉。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

async function freshGuards() {
  vi.resetModules()
  return (await import('../src/lib/process-guards.ts')).installProcessGuards
}

function listeners(event: string): Handler[] {
  return process.listeners(event) as Handler[]
}

function fire(event: string, ...args: unknown[]): void {
  for (const handler of listeners(event)) handler(...args)
}

afterEach(() => {
  process.removeAllListeners('unhandledRejection')
  process.removeAllListeners('uncaughtException')
  vi.restoreAllMocks()
})

describe('installProcessGuards', () => {
  it('未处理的拒绝被记录且不退出进程', async () => {
    const errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    ;(await freshGuards())()

    fire('unhandledRejection', new Error('boom'))

    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[1] ?? '')).toContain('boom')
    expect(exit).not.toHaveBeenCalled()
  })

  it('未捕获异常仍然终止进程（不带着未知状态继续跑）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    ;(await freshGuards())()

    fire('uncaughtException', new Error('fatal'))

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('重复安装不会叠加监听器', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const install = await freshGuards()
    install()
    install()

    expect(listeners('unhandledRejection')).toHaveLength(1)
    expect(listeners('uncaughtException')).toHaveLength(1)
  })

  it('非 Error 的拒绝原因也能被记录', async () => {
    const errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    ;(await freshGuards())()

    fire('unhandledRejection', { weird: true })

    expect(String(errors[0]?.[1] ?? '')).toContain('weird')
  })

  it('循环引用的拒绝原因不会让记录本身抛错', async () => {
    const errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    ;(await freshGuards())()
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic

    fire('unhandledRejection', cyclic)

    expect(errors).toHaveLength(1)
  })
})