/**
 * M0 冒烟：vendor/cordis + storage 四件套在源码直跑（tsx）模式下可用。
 *
 * 组装配方与 dsh message-feedback 测试一致：Storage hub → JSON backend →
 * domain facility → storageDomain.open(spec)。验证：put/put 幂等重写、
 * global set、域级原子 update、以及重开 ctx 后介质（JSON 文件）持久。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'

interface HelloRecord {
  readonly path: string
  readonly title: string
}

const helloDomain = StorageDomain.defineDomain({
  name: 'hello_smoke',
  version: 1,
  tables: {
    greetings: StorageDomain.domainTable<`g-${string}`, HelloRecord>(
      z.object({ path: z.string(), title: z.string() }),
    ),
  },
  global: { schema: z.object({ last: z.string() }), initial: { last: '' } },
})

async function assemble(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-smoke-'))
  try {
    {
      const ctx = await assemble(root)
      const domain = await ctx.storageDomain.open(helloDomain)
      const greetings = domain.table('greetings')
      await greetings.put('g-1', { path: 'D:/a', title: '每日工作总结' })
      await greetings.put('g-2', { path: 'D:/b', title: '智能纪要' })
      await domain.global.set({ last: 'g-2' })
      // 域级原子读改写：追加式更新不覆盖其他记录
      await greetings.update('g-1', current => ({ ...current, title: '每日工作总结（改名）' }))
      await domain.close()
      await ctx.fiber.dispose()
    }

    {
      const ctx = await assemble(root)
      const domain = await ctx.storageDomain.open(helloDomain)
      const greetings = domain.table('greetings')
      const first = greetings.get('g-1')
      const second = greetings.get('g-2')
      const size = greetings.size
      const global = domain.global.get()
      await domain.close()
      await ctx.fiber.dispose()

      if (first?.title !== '每日工作总结（改名）') throw new Error(`record 1 lost or wrong: ${JSON.stringify(first)}`)
      if (second?.title !== '智能纪要') throw new Error(`record 2 lost: ${JSON.stringify(second)}`)
      if (size !== 2) throw new Error(`expected 2 records, got ${size}`)
      if (global.last !== 'g-2') throw new Error(`global lost: ${JSON.stringify(global)}`)

      const medium = JSON.parse(await readFile(join(root, 'hello_smoke.json'), 'utf8')) as Record<string, unknown>
      console.log('[smoke] medium file keys:', Object.keys(medium).join(', '))
    }
    console.log('[smoke] storage stack OK: put/update/global/durability all verified')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
