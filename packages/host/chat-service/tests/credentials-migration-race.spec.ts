import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({
  blocked: false, config: '', plaintext: '', entered: () => {}, wait: Promise.resolve(),
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (path: unknown, ...args: unknown[]) => {
    if (fault.config && String(path).endsWith('config.yaml')) return Promise.resolve(fault.config)
    if (fault.blocked && String(path).endsWith('credentials.json')) return Promise.resolve(fault.plaintext)
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...args)
  } }
})
vi.mock('../src/secret-box.ts', async original => {
  const actual = await original<typeof import('../src/secret-box.ts')>()
  return { ...actual, sealCredentials: async (data: Record<string, string>) => {
    if (fault.blocked) { fault.entered(); await fault.wait }
    return actual.sealCredentials(data)
  } }
})
vi.mock('@studyclaw/course-builder', async original => {
  const actual = await original<typeof import('@studyclaw/course-builder')>()
  return { ...actual, probeMineru: async () => ({ available: false, command: null, reason: 'fixture' }) }
})
import { setCredential, settingsPayload } from '../src/settings.ts'
import { unsealCredentials } from '../src/secret-box.ts'

afterEach(() => { fault.blocked = false; fault.config = ''; fault.plaintext = ''; vi.unstubAllEnvs() })

describe('旧凭据迁移与新 Key 保存', () => {
  it('迁移排队中的读取不能用旧快照覆盖新保存的 Key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-credential-race-'))
    vi.stubEnv('STUDYCLAW_HOME', join(root, 'host-home'))
    vi.stubEnv('FIXTURE_API_KEY', '')
    await mkdir(join(root, '.studyclaw'))
    fault.config = 'active_provider: fixture\nproviders:\n  fixture:\n    model: fixture\n    base_url: https://fixture.invalid\n    api_key_env: FIXTURE_API_KEY\n'
    fault.plaintext = JSON.stringify({ FIXTURE_API_KEY: 'FAKE-OLD' })
    await writeFile(join(root, '.studyclaw', 'credentials.json'), fault.plaintext)
    let release!: () => void
    fault.wait = new Promise<void>(yes => { release = yes })
    const entered = new Promise<void>(yes => { fault.entered = yes })
    fault.blocked = true
    const first = settingsPayload(root)
    let save: Promise<unknown> | undefined, second: Promise<unknown> | undefined
    try {
      await entered
      save = setCredential(root, 'fixture', 'FAKE-NEW')
      await new Promise<void>(yes => setImmediate(yes))
      second = settingsPayload(root)
      await new Promise<void>(yes => setImmediate(yes))
      fault.blocked = false
      release()
      await Promise.all([first, save, second])
      const disk = await unsealCredentials(await readFile(join(root, '.studyclaw', 'credentials.json'), 'utf8'))
      expect(disk.data['FIXTURE_API_KEY']).toBe('FAKE-NEW')
    } finally {
      fault.blocked = false
      release()
      await Promise.allSettled([first, save, second])
      await rm(root, { recursive: true, force: true })
    }
  })
});
