/**
 * P1-6 回归：withCourseLock 必须真正串行化同 key 的临界区，且单个临界区
 * 抛错不能卡死后续等待者。
 */

import { describe, expect, it } from 'vitest'
import { withCourseLock } from '../src/handlers.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('withCourseLock', () => {
  it('并发调用严格互斥（maxConcurrent === 1）', async () => {
    let running = 0
    let maxConcurrent = 0
    await Promise.all(Array.from({ length: 6 }, () => withCourseLock('course-a', async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await sleep(8)
      running -= 1
    })))
    expect(maxConcurrent).toBe(1)
  })

  it('不同 key 并不互斥', async () => {
    let running = 0
    let concurrentSeen = false
    const barrier = new Promise<void>(resolve => {
      setTimeout(resolve, 30)
    })
    await Promise.all(['k1', 'k2'].map(key => withCourseLock(key, async () => {
      running += 1
      if (running > 1) concurrentSeen = true
      await barrier
      running -= 1
    })))
    expect(concurrentSeen).toBe(true)
  })

  it('失败只影响自身，后续临界区照常执行且拿到值', async () => {
    const order: string[] = []
    await Promise.allSettled([
      withCourseLock('course-b', async () => {
        await sleep(5)
        throw new Error('第一个持有者失败')
      }),
      withCourseLock('course-b', async () => {
        order.push('second')
        return 'ok'
      }),
    ])
    expect(order).toEqual(['second'])
  })
})
