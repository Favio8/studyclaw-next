import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ codes: [] as string[], calls: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: string, to: string) => {
    fault.calls += 1
    const code = fault.codes.shift()
    if (code) throw Object.assign(new Error(code), { code })
    return actual.rename(from, to)
  } }
})
import { renameWithRetry } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  fault.codes = []
  fault.calls = 0
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['EPERM', 'EBUSY', 'EACCES'])('retries %s and then installs the actual file', async code => {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-retry-'))
  roots.push(root)
  await mkdir(join(root, 'state'))
  const target = join(root, 'state', 'config.yaml')
  const temporary = `${target}.tmp`
  await writeFile(target, 'old')
  await writeFile(temporary, 'new')
  fault.codes = [code]
  await renameWithRetry(temporary, target)
  expect(fault.calls).toBe(2)
  expect(await readFile(target, 'utf8')).toBe('new')
})

it('does not retry a real cross-volume error', async () => {
  fault.codes = ['EXDEV']
  await expect(renameWithRetry('a', 'b')).rejects.toMatchObject({ code: 'EXDEV' })
  expect(fault.calls).toBe(1)
})

it('persistent occupation terminates with the original filesystem error', async () => {
  vi.useFakeTimers()
  fault.codes = Array(10).fill('EBUSY')
  const result = expect(renameWithRetry('a', 'b')).rejects.toMatchObject({ code: 'EBUSY' })
  await vi.runAllTimersAsync()
  await result
  expect(fault.calls).toBeGreaterThan(1)
  expect(fault.calls).toBeLessThanOrEqual(4)
})
