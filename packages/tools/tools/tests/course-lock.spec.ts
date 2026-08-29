/**
 * P1-6 回归：withCourseLock 必须真正串行化同 key 的临界区，且单个临界区
 * 抛错不能卡死后续等待者。
 * FL-36：锁现在含跨进程文件层（`<课程>/.studyclaw/course.lock`），key 必须
 * 是真实目录——用 os.tmpdir 下的独立目录，避免污染仓库工作目录。
 */

import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withCourseLock } from '../src/handlers.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function makeCourseDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'studyclaw-lock-'))
}

describe('withCourseLock', () => {
  it('并发调用严格互斥（maxConcurrent === 1）', async () => {
    const dir = await makeCourseDir()
    try {
      let running = 0
      let maxConcurrent = 0
      await Promise.all(Array.from({ length: 6 }, () => withCourseLock(dir, async () => {
        running += 1
        maxConcurrent = Math.max(maxConcurrent, running)
        await sleep(8)
        running -= 1
      })))
      expect(maxConcurrent).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('不同 key 并不互斥', async () => {
    const [dirA, dirB] = [await makeCourseDir(), await makeCourseDir()]
    try {
      let running = 0
      let concurrentSeen = false
      const barrier = new Promise<void>(resolve => {
        setTimeout(resolve, 30)
      })
      await Promise.all([dirA, dirB].map(key => withCourseLock(key, async () => {
        running += 1
        if (running > 1) concurrentSeen = true
        await barrier
        running -= 1
      })))
      expect(concurrentSeen).toBe(true)
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })

  it('失败只影响自身，后续临界区照常执行且拿到值', async () => {
    const dir = await makeCourseDir()
    try {
      const order: string[] = []
      await Promise.allSettled([
        withCourseLock(dir, async () => {
          await sleep(5)
          throw new Error('第一个持有者失败')
        }),
        withCourseLock(dir, async () => {
          order.push('second')
          return 'ok'
        }),
      ])
      expect(order).toEqual(['second'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('FL-36 回归：持有者进程死亡后，陈旧锁文件被后来者自愈抢走', async () => {
    const dir = await makeCourseDir()
    try {
      // 模拟一个崩溃进程留下的锁：pid 写成不可能存活的 2^22 以上的大数
      //（多数 OS 的 pid 上限远小于此），isPidAlive 判死 → 锁应被抢走。
      const lockDir = join(dir, '.studyclaw')
      await mkdir(lockDir, { recursive: true })
      await writeFile(join(lockDir, 'course.lock'), '999999999', 'utf8')
      const result = await withCourseLock(dir, async () => 'acquired')
      expect(result).toBe('acquired')
      // 临界区结束后锁文件应被清理。
      expect(await readFile(join(lockDir, 'course.lock'), 'utf8').then(() => true, () => false)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
