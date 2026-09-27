/**
 * C-6 回归：wireStdin 的 resume() 让 stdin 句柄常驻事件循环——交互命令
 * （quiz/review/chat）跑完后进程永不退出（代理实测挂起；此前测试全部注入
 * 自定义 prompt，wireStdin 零覆盖故长期潜伏）。
 * 修复：wired 后 unref；prompt 等待期间 ref、结算后 unref。
 */

import { describe, expect, it, vi } from 'vitest'
import { makeTerminal } from '../src/lib/terminal.ts'

const stdin = process.stdin as { ref?: () => void; unref?: () => void }

describe('terminal stdin 生命周期（C-6）', () => {
  it.runIf(typeof stdin.ref === 'function' && typeof stdin.unref === 'function')(
    '等待输入期间 ref、行到达结算后 unref（stdin 不兜底事件循环）',
    async () => {
      const ref = vi.spyOn(stdin, 'ref' as never).mockImplementation(() => process.stdin)
      const unref = vi.spyOn(stdin, 'unref' as never).mockImplementation(() => process.stdin)
      try {
        const terminal = makeTerminal({ tty: false, sink: { write: () => undefined, line: () => undefined } })
        const pending = terminal.prompt('Q: ')
        // 等待态：ref 已调用（unref 的 stdin 不会阻止进程提前退出）。
        expect(ref).toHaveBeenCalled()
        // 喂一行：走 wireStdin 的 data 拆行路径。
        process.stdin.emit('data', 'my answer\n')
        await expect(pending).resolves.toBe('my answer')
        // 结算后 unref：wireStdin 一次 + settle 一次（命令结束后进程可自然排空）。
        expect(unref.mock.calls.length).toBeGreaterThanOrEqual(2)
      } finally {
        ref.mockRestore()
        unref.mockRestore()
      }
    },
  )

  it('C-8：管道行数超过上限时截断且只告警一次（无上界会常驻整个文件）', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      // 自备接线（prompt 挂起 → wireStdin），不依赖其他用例的模块级状态。
      const terminal = makeTerminal({ tty: false, sink: { write: () => undefined, line: () => undefined } })
      const first = terminal.prompt('Q: ')
      const payload = Array.from({ length: 1200 }, (_, index) => `line-${index}\n`).join('')
      process.stdin.emit('data', payload)
      // 首行结算挂起的 prompt，其余进队列；超过 1000 行上限丢弃且只告警一次。
      await expect(first).resolves.toBe('line-0')
      const warnings = stderr.mock.calls.filter(call => String(call[0]).includes('超过 1000 行上限'))
      expect(warnings).toHaveLength(1)
    } finally {
      stderr.mockRestore()
    }
  })
})
