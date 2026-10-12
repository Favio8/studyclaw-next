import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ rejectNext: false }))
vi.mock('../src/atomic.ts', async original => {
  const actual = await original<typeof import('../src/atomic.ts')>()
  return { ...actual, writeAtomic: (path: string, data: string) => {
    if (fault.rejectNext) { fault.rejectNext = false; return Promise.reject(new Error('INJECTED WRITE FAILURE')) }
    return actual.writeAtomic(path, data)
  } }
})
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { fault.rejectNext = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('并发失败不能回滚已成功的存储操作', () => {
  it.each(['put', 'global', 'delete'])('%s 失败时后续成功写入在内存和落盘都保留', async operation => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-json-race-'))
    roots.push(root)
    await mkdir(root, { recursive: true })
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'state', version: 1, tables: ['t'], hasGlobal: true })
    try {
      await unit.putRecord('t', 'k', { value: 'before' })
      await unit.setGlobal({ value: 'before' })
      fault.rejectNext = true
      const first = operation === 'global' ? unit.setGlobal({ value: 'failed' })
        : operation === 'delete' ? unit.deleteRecord('t', 'k') : unit.putRecord('t', 'k', { value: 'failed' })
      const second = operation === 'global' ? unit.setGlobal({ value: 'success' }) : unit.putRecord('t', 'k', { value: 'success' })
      const results = await Promise.allSettled([first, second])
      expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
      const snapshot = await unit.loadAll()
      expect(operation === 'global' ? snapshot.global : snapshot.tables['t']?.['k']).toEqual({ value: 'success' })
      const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
      expect(operation === 'global' ? disk.global : disk.tables.t.k).toEqual({ value: 'success' })
    } finally { await backend.close() }
  })
});
