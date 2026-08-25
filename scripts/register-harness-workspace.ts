/**
 * 临时测试脚本：把 harness_learning 注册进宿主工作区注册表并设为当前工作区。
 * 用法：tsx --tsconfig tsconfig.base.json scripts/register-harness-workspace.ts
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { WorkspaceRegistry } from '@studyclaw/workspace'

const hostHome = (): string => process.env.STUDYCLAW_HOME ?? join(homedir(), '.studyclaw')

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: hostHome() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.workspaceRegistry
  const path = 'C:/Users/Favio/Desktop/harness_learning'
  const result = await registry.create(path, 'harness_learning')
  await registry.setLastOpenedPath(path)
  console.log(JSON.stringify({
    created: result.created,
    id: result.workspace.id,
    path: result.workspace.path,
    lastOpenedPath: registry.lastOpenedPath,
  }, null, 2))
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
