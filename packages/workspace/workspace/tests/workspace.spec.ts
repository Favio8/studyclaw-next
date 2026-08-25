/**
 * WorkspaceRegistry behavior suite, ported from the dsh-workspace test
 * coverage with session accounting removed (M1 scope). Runs against the real
 * storage stack (cordis + storage hub + JSON backend in a temp dir), so every
 * case also pins durability of the underlying medium.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry, { WorkspaceNameConflictError, WorkspaceOrderInvalidError } from '../src/index.ts'
import { workspaceDomainSpec } from '../src/spec.ts'

async function seedDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

interface Harness {
  readonly root: string
  readonly ctx: Context
  registry: WorkspaceRegistry
  dispose(): Promise<void>
}

async function setup(root?: string): Promise<Harness> {
  const resolved = root ?? await mkdtemp(join(tmpdir(), 'studyclaw-workspace-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: resolved })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  let disposed = false
  return {
    root: resolved,
    ctx,
    registry: ctx.workspaceRegistry,
    // Only the context is torn down here; the medium directory is owned by
    // the caller (the restart suite reopens it, so afterEach removes it).
    // Idempotent: the restart suite disposes first, afterEach disposes again.
    async dispose() {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
    },
  }
}

describe('WorkspaceRegistry', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await setup()
  })

  afterEach(async () => {
    await harness.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  it('create prepends to the authoritative order and stamps timestamps', async () => {
    const dirA = join(harness.root, 'alpha')
    const dirB = join(harness.root, 'beta')
    await seedDir(dirA)
    await seedDir(dirB)

    const first = await harness.registry.create(dirA)
    const second = await harness.registry.create(dirB)

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    const ids = harness.registry.list().map(workspace => workspace.id)
    expect(ids).toEqual([second.workspace.id, first.workspace.id])
    expect(harness.registry.list()[0]?.path).toBe(dirB)
    expect(harness.registry.list()[1]?.title).toBe('alpha')
    expect(harness.registry.list()[0]?.createdAt).toBeDefined()
    expect(harness.registry.list()[0]?.updatedAt).toBeDefined()
  })

  it('is idempotent across path spellings of the same directory', async () => {
    const dir = join(harness.root, 'alpha')
    await seedDir(dir)

    const first = await harness.registry.create(dir)
    // Trailing slash, ..-segment and case-variant spellings collapse to the
    // same canonical path (case folding is realpath's platform behavior).
    const again = await harness.registry.create(join(harness.root, 'alpha', '.', ''))
    const parent = await harness.registry.create(join(harness.root, 'alpha', '..', 'alpha'))

    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(parent.created).toBe(false)
    expect(again.workspace.id).toBe(first.workspace.id)
    expect(parent.workspace.id).toBe(first.workspace.id)
    expect(harness.registry.list()).toHaveLength(1)
    // A repeated create never changes the original title.
    expect(again.workspace.title).toBe('alpha')
  })

  it('rejects a nonexistent path and a non-directory path', async () => {
    await expect(harness.registry.create(join(harness.root, 'gone'))).rejects.toThrow()
    const file = join(harness.root, 'file.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'x', 'utf8')
    await expect(harness.registry.create(file)).rejects.toThrow('not a directory')
  })

  it('allows duplicate titles across different paths', async () => {
    const dirA = join(harness.root, 'alpha')
    const dirB = join(harness.root, 'beta')
    await seedDir(dirA)
    await seedDir(dirB)

    const a = await harness.registry.create(dirA, '相同标题')
    const b = await harness.registry.create(dirB, '相同标题')

    expect(a.workspace.id).not.toBe(b.workspace.id)
    expect(a.workspace.title).toBe(b.workspace.title)
  })

  it('rename trims, resolves no-op without writing, and rejects conflicts', async () => {
    const dirA = join(harness.root, 'alpha')
    const dirB = join(harness.root, 'beta')
    await seedDir(dirA)
    await seedDir(dirB)
    const a = await harness.registry.create(dirA)
    const b = await harness.registry.create(dirB)

    await harness.registry.rename(a.workspace.id, '  新标题  ')
    expect(harness.registry.get(a.workspace.id)?.title).toBe('新标题')

    const updatedAt = harness.registry.get(a.workspace.id)?.updatedAt
    await harness.registry.rename(a.workspace.id, '新标题')
    expect(harness.registry.get(a.workspace.id)?.updatedAt).toBe(updatedAt)

    await expect(harness.registry.rename(b.workspace.id, '新标题')).rejects.toThrow(WorkspaceNameConflictError)
    await expect(harness.registry.rename(b.workspace.id, '新标题')).rejects.toThrow("already named '新标题'")
  })

  it('insertBefore moves within the order and appends without an anchor', async () => {
    const dirs = ['one', 'two', 'three'].map(name => join(harness.root, name))
    for (const dir of dirs) await seedDir(dir)
    // Sequential: concurrent creates race on realpath before enqueueing, so
    // the durable order would not reflect the creation order below.
    const one = await harness.registry.create(dirs[0]!)
    const two = await harness.registry.create(dirs[1]!)
    const three = await harness.registry.create(dirs[2]!)
    // created order: three, two, one

    await harness.registry.insertBefore(one.workspace.id, three.workspace.id)
    expect(harness.registry.list().map(w => w.path)).toEqual([join(harness.root, 'one'), join(harness.root, 'three'), join(harness.root, 'two')])

    await harness.registry.insertBefore(two.workspace.id)
    expect(harness.registry.list().map(w => w.path)).toEqual([join(harness.root, 'one'), join(harness.root, 'three'), join(harness.root, 'two')])

    await harness.registry.insertBefore(two.workspace.id, one.workspace.id)
    expect(harness.registry.list().map(w => w.path)).toEqual([join(harness.root, 'two'), join(harness.root, 'one'), join(harness.root, 'three')])

    await expect(harness.registry.insertBefore(one.workspace.id, 'g-unknown' as never)).rejects.toThrow(WorkspaceOrderInvalidError)
    await expect(harness.registry.insertBefore('g-unknown' as never)).rejects.toThrow(WorkspaceOrderInvalidError)
  })

  it('delete forgets the registration, keeps order consistent, and idempotently resolves unknown ids', async () => {
    const dirA = join(harness.root, 'alpha')
    const dirB = join(harness.root, 'beta')
    await seedDir(dirA)
    await seedDir(dirB)
    const a = await harness.registry.create(dirA)
    const b = await harness.registry.create(dirB)

    expect(await harness.registry.delete(a.workspace.id)).toBe(true)
    expect(harness.registry.list().map(w => w.path)).toEqual([dirB])
    expect(await harness.registry.delete(a.workspace.id)).toBe(false)
    // Directory data untouched.
    const { stat } = await import('node:fs/promises')
    expect((await stat(dirA)).isDirectory()).toBe(true)
  })

  it('recreate after delete produces a fresh record at the front', async () => {
    const dir = join(harness.root, 'alpha')
    await seedDir(dir)
    const first = await harness.registry.create(dir)
    await harness.registry.delete(first.workspace.id)
    const second = await harness.registry.create(dir)
    expect(second.created).toBe(true)
    expect(second.workspace.id).not.toBe(first.workspace.id)
    expect(harness.registry.list()).toHaveLength(1)
  })

  it('survives a registry restart over the same medium', async () => {
    const dir = join(harness.root, 'alpha')
    await seedDir(dir)
    const created = await harness.registry.create(dir, '持久标题')
    await harness.registry.insertBefore(created.workspace.id)
    await harness.dispose()

    const reborn = await setup(harness.root)
    try {
      expect(reborn.registry.list()).toHaveLength(1)
      expect(reborn.registry.get(created.workspace.id)?.title).toBe('持久标题')
      expect(reborn.registry.list()[0]?.path).toBe(dir)
    } finally {
      await reborn.dispose()
    }
  })

  it('validateStoredState fails loud on a record absent from the order', async () => {
    // Fabricate the divergence by writing directly through the domain: an
    // orphaned table row plus a stale global.
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-workspace-'))
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const domain = await ctx.storageDomain.open(workspaceDomainSpec)
    await domain.global.set({ initialized: true, workspaceIds: [] })
    await domain.table('workspaces').put('g-orphan', {
      path: join(root, 'gone'),
      title: 'orphan',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    await domain.close()
    await ctx.fiber.dispose()

    const reborn = new Context()
    await reborn.plugin(Storage)
    await reborn.plugin(StorageJson, { root })
    await reborn.plugin(StorageDomain, { backend: 'json' })
    await expect(reborn.plugin(WorkspaceRegistry)).rejects.toThrow('absent from registry order')
    await reborn.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
})
