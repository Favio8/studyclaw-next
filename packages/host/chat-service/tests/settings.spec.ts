/**
 * Settings domain suite: config.yaml round-trip projection, provider CRUD,
 * credential storage, activation, partial update, and /models discovery
 * normalization (against a local mock server).
 */

import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateProvider,
  deleteProvider,
  discoverModels,
  saveProvider,
  setCredential,
  settingsPayload,
  updateSettings,
} from '../src/settings.ts'
import { loadChatConfig } from '../src/config.ts'
import { unsealCredentials } from '../src/secret-box.ts'

async function setup(): Promise<{ root: string; ws: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-settings-'))
  const ws = join(root, 'ws')
  // 隔离 master.key：密封凭据的密钥必须落在测试临时目录而不是真实用户目录。
  process.env.STUDYCLAW_HOME = join(ws, '.studyclaw')
  await mkdir(join(ws, '.studyclaw'), { recursive: true })
  await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
    'version: 1',
    'llm:',
    '  provider: mock',
    '  model: mock-model',
    '  api_key_env: MOCK_KEY',
    '  api_base: https://example.com/v1',
    '  temperature: 0.3',
    '  max_concurrency: 1',
    'providers:',
    '  mock:',
    '    id: mock',
    '    name: Mock 端点',
    '    model: mock-model',
    '    base_url: https://example.com/v1',
    '    api_key_env: MOCK_KEY',
    '    temperature: 0.3',
    '    max_concurrency: 1',
    '    models:',
    '    - id: mock-model',
    '      name: Mock Model',
    'ui:',
    '  default_mode: socratic',
    '',
  ].join('\n'), 'utf8')
  return { root, ws }
}

describe('settings domain', () => {
  afterEach(() => {
    delete process.env.STUDYCLAW_HOME
  })

  it('resolves credentials saved under the generated apiKeyEnv reference', async () => {
    const { root, ws } = await setup()
    await setCredential(ws, 'mock', 'mock-secret')
    const config = await loadChatConfig(ws)
    expect(config.apiKey).toBe('mock-secret')
    expect(config.apiKeyEnv).toBe('MOCK_API_KEY')
    await rm(root, { recursive: true, force: true })
  })

  it('projects the full payload from config.yaml', async () => {
    const { root, ws } = await setup()
    const payload = await settingsPayload(ws)
    expect(payload.activeProviderId).toBe('mock')
    expect(payload.providers).toHaveLength(1)
    expect(payload.providers[0]).toMatchObject({ id: 'mock', model: 'mock-model', models: [{ id: 'mock-model' }] })
    expect(payload.llm.apiBase).toBe('https://example.com/v1')
    expect(payload.ui.defaultMode).toBe('socratic')
    await rm(root, { recursive: true, force: true })
  })

  it('saveProvider upserts and preserves the credential ref', async () => {
    const { root, ws } = await setup()
    const payload = await saveProvider(ws, {
      id: 'new-provider',
      name: '新端点',
      model: 'gpt-x',
      baseUrl: 'https://gate.example.com/v1',
      temperature: 0.2,
      maxConcurrency: 2,
      models: [{ id: 'gpt-x', name: 'GPT-X', contextWindow: 1000, maxTokens: 500 }],
    })
    expect(payload.providers.map(p => p.id)).toContain('new-provider')
    const raw = await readFile(join(ws, '.studyclaw', 'config.yaml'), 'utf8')
    expect(raw).toContain('new-provider:')
    await rm(root, { recursive: true, force: true })
  })

  it('setCredential seals credentials.json and backfills api_key_env (P0-2)', async () => {
    const { root, ws } = await setup()
    await setCredential(ws, 'mock', 'sk-test-123')
    const raw = await readFile(join(ws, '.studyclaw', 'credentials.json'), 'utf8')
    // 密文形态：明文 key 不允许再出现在落盘文件里。
    expect(raw).toContain('"sealed": true')
    expect(raw).not.toContain('sk-test-123')
    const creds = (await unsealCredentials(raw)).data
    expect(creds['MOCK_API_KEY']).toBe('sk-test-123')
    const payload = await settingsPayload(ws)
    expect(payload.providers[0]!.apiKeyConfigured).toBe(true)
    expect(payload.providers[0]!.apiKeyEnv).toBe('MOCK_API_KEY')
    process.env.STUDYCLAW_HOME = ''
    delete process.env.STUDYCLAW_HOME
    await rm(root, { recursive: true, force: true })
  })

  it('legacy 明文凭据在读取时自动迁移为密文（P0-2）', async () => {
    const { root, ws } = await setup()
    await writeFile(join(ws, '.studyclaw', 'credentials.json'), JSON.stringify({ MOCK_KEY: 'sk-legacy' }), 'utf8')
    const payload = await settingsPayload(ws)
    expect(payload.providers[0]!.apiKeyConfigured).toBe(true)
    const raw = await readFile(join(ws, '.studyclaw', 'credentials.json'), 'utf8')
    expect(raw).toContain('"sealed": true')
    const creds = (await unsealCredentials(raw)).data
    expect(creds['MOCK_KEY']).toBe('sk-legacy')
    process.env.STUDYCLAW_HOME = ''
    delete process.env.STUDYCLAW_HOME
    await rm(root, { recursive: true, force: true })
  })

  it('deleteProvider removes the record, credential, and clears the active pointer (no phantom route)', async () => {
    const { root, ws } = await setup()
    await setCredential(ws, 'mock', 'sk-test-123')
    const payload = await deleteProvider(ws, 'mock')
    expect(payload.providers).toHaveLength(0)
    expect(payload.activeProviderId).toBe('')
    const raw = await readFile(join(ws, '.studyclaw', 'credentials.json'), 'utf8')
    const creds = (await unsealCredentials(raw)).data
    expect(creds['MOCK_API_KEY']).toBeUndefined()
    process.env.STUDYCLAW_HOME = ''
    delete process.env.STUDYCLAW_HOME
    await rm(root, { recursive: true, force: true })
  })

  it('activateProvider updates the active pointer', async () => {
    const { root, ws } = await setup()
    await saveProvider(ws, {
      id: 'second', name: '第二端点', model: 'm2', baseUrl: 'https://s.example.com/v1',
      temperature: 0.3, maxConcurrency: 1, models: [],
    })
    const payload = await activateProvider(ws, 'second')
    expect(payload.activeProviderId).toBe('second')
    expect(payload.llm.model).toBe('m2')
    await rm(root, { recursive: true, force: true })
  })

  it('updateSettings changes defaultMode and rejects invalid modes', async () => {
    const { root, ws } = await setup()
    const payload = await updateSettings(ws, { defaultMode: 'feynman' })
    expect(payload.ui.defaultMode).toBe('feynman')
    await expect(updateSettings(ws, { defaultMode: 'bogus' })).rejects.toThrow('默认学习模式无效')
    await rm(root, { recursive: true, force: true })
  })

  it('projects DSH agent presets, permission presets and plugin degradation state', async () => {
    const { root, ws } = await setup()
    const initial = await settingsPayload(ws)
    expect(initial.agent.preset).toBe('studyclaw-learning')
    expect(initial.permissions.preset).toBe('workspace-write')
    expect(initial.plugins.inventory.find(item => item.id === 'sandbox')).toMatchObject({ enabled: false, reason: '未配置隔离 Provider' })
    const next = await updateSettings(ws, { agentPreset: 'general', permissionPreset: 'read-only', plugins: { sandbox: true } })
    expect(next.agent.preset).toBe('general')
    expect(next.permissions.preset).toBe('read-only')
    expect(next.plugins.inventory.find(item => item.id === 'sandbox')).toMatchObject({ enabled: true })
    await expect(updateSettings(ws, { permissionPreset: 'unknown' })).rejects.toThrow('权限 preset 无效')
    await rm(root, { recursive: true, force: true })
  })

  it('discoverModels normalizes /models responses (mock server)', async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'model-a', name: 'Model A', context_length: 8192, max_output_length: 2048 },
          { id: 'model-b' },
          { id: '' },
        ],
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}/v1` : ''
    const models = await discoverModels({ baseUrl })
    expect(models).toEqual([
      { id: 'model-a', name: 'Model A', contextWindow: 8192, maxTokens: 2048 },
      { id: 'model-b', name: 'model-b', contextWindow: null, maxTokens: null },
    ])
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('discoverModels 拒绝非 http(s)、内嵌凭据与白名单外环境变量（SEC-2）', async () => {
    await expect(discoverModels({ baseUrl: 'file:///etc/passwd' })).rejects.toThrow('只支持 http/https')
    await expect(discoverModels({ baseUrl: 'http://user:pass@example.com/v1' })).rejects.toThrow('不允许内嵌用户名')
    // PATH 不是 API Key 命名：即使配合恶意 URL 也带不出任意环境变量值。
    process.env.STUDYCLAW_TEST_SECRET_ENV = 'secret-value'
    await expect(discoverModels({ baseUrl: 'http://127.0.0.1:9/x', apiKeyEnv: 'PATH' }))
      .rejects.toThrow('环境变量名不在允许列表内')
    delete process.env.STUDYCLAW_TEST_SECRET_ENV
  })

  it('discoverModels 连接失败的报错不回显目标地址（SEC-2 脱敏）', async () => {
    let message = ''
    try {
      await discoverModels({ baseUrl: 'http://127.0.0.1:9/probe-path' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('/probe-path')
    expect(message).toContain('无法连接模型端点')
  })

  it('saveProvider merges: omitted temperature/maxConcurrency/models survive', async () => {
    const { root, ws } = await setup()
    // 先建一个带自定义高级字段的 provider。
    await saveProvider(ws, {
      id: 'merge-provider', name: '合并端点', model: 'm1', baseUrl: 'https://m.example.com/v1',
      temperature: 0.7, maxConcurrency: 6,
      models: [{ id: 'm1', name: 'M1', contextWindow: 200000, maxTokens: 4096 }],
    })
    // 编辑既有 id（overwrite）只改名称：temperature/maxConcurrency/models
    // 全部缺省 → 保留现值。
    const after = await saveProvider(ws, {
      id: 'merge-provider', name: '改名端点', model: 'm1', baseUrl: 'https://m.example.com/v1',
      overwrite: true,
    })
    const provider = after.providers.find(p => p.id === 'merge-provider')!
    expect(provider.name).toBe('改名端点')
    expect(provider.temperature).toBe(0.7)
    expect(provider.maxConcurrency).toBe(6)
    expect(provider.models).toEqual([{ id: 'm1', name: 'M1', contextWindow: 200000, maxTokens: 4096 }])
    await rm(root, { recursive: true, force: true })
  })

  it('saveProvider merge: models=[] clears, models=null keeps, array replaces', async () => {
    const { root, ws } = await setup()
    await saveProvider(ws, {
      id: 'models-provider', name: '列表端点', model: 'a', baseUrl: null,
      temperature: 0.3, maxConcurrency: 1,
      models: [{ id: 'a', name: 'A', contextWindow: null, maxTokens: null }],
    })
    // null = 保留现有列表。
    const kept = await saveProvider(ws, {
      id: 'models-provider', name: '列表端点', model: 'a', baseUrl: null,
      models: null, overwrite: true,
    })
    expect(kept.providers.find(p => p.id === 'models-provider')!.models).toHaveLength(1)
    // [] = 显式清空。
    const cleared = await saveProvider(ws, {
      id: 'models-provider', name: '列表端点', model: 'a', baseUrl: null,
      models: [], overwrite: true,
    })
    expect(cleared.providers.find(p => p.id === 'models-provider')!.models).toHaveLength(0)
    await rm(root, { recursive: true, force: true })
  })

  it('saveProvider merge: hand-edited unknown YAML keys survive a rebuild', async () => {
    const { root, ws } = await setup()
    // 直接手写 config.yaml（模拟用户手工加了自定义字段 custom_field）。
    await writeFile(join(ws, '.studyclaw', 'config.yaml'), [
      'version: 1',
      'llm:',
      '  provider: unknown-keys',
      '  model: a',
      'providers:',
      '  unknown-keys:',
      '    id: unknown-keys',
      '    name: 带未知键',
      '    model: a',
      '    base_url: null',
      '    temperature: 0.3',
      '    max_concurrency: 1',
      '    models: []',
      '    custom_field: hello',
      '',
    ].join('\n'), 'utf8')
    // 保存只改 name：custom_field 必须保留（merge 非重建）。
    await saveProvider(ws, {
      id: 'unknown-keys', name: '改名', model: 'a', baseUrl: null,
      temperature: 0.3, maxConcurrency: 1, models: [], overwrite: true,
    })
    const rebuilt = await readFile(join(ws, '.studyclaw', 'config.yaml'), 'utf8')
    expect(rebuilt).toContain('custom_field: hello')
    await rm(root, { recursive: true, force: true })
  })

  it('saveProvider rejects creating an existing id without overwrite (409)', async () => {
    const { root, ws } = await setup()
    await saveProvider(ws, {
      id: 'dup', name: '已存在', model: 'a', baseUrl: null,
      temperature: 0.3, maxConcurrency: 1, models: [],
    })
    await expect(saveProvider(ws, {
      id: 'dup', name: '覆盖尝试', model: 'b', baseUrl: null,
      temperature: 0.3, maxConcurrency: 1, models: [],
    })).rejects.toThrow('已存在')
    // 显式 overwrite 后成功。
    const after = await saveProvider(ws, {
      id: 'dup', name: '覆盖成功', model: 'b', baseUrl: null,
      temperature: 0.3, maxConcurrency: 1, models: [], overwrite: true,
    })
    expect(after.providers.find(p => p.id === 'dup')!.name).toBe('覆盖成功')
    await rm(root, { recursive: true, force: true })
  })

  it('M3：并发保存两个 provider 双双存活（config 写锁串行化 RMW）', async () => {
    const { root, ws } = await setup()
    await Promise.all([
      saveProvider(ws, { id: 'alpha', name: 'Alpha', model: 'model-a', baseUrl: 'https://a.example/v1' }),
      saveProvider(ws, { id: 'beta', name: 'Beta', model: 'model-b', baseUrl: 'https://b.example/v1' }),
    ])
    const payload = await settingsPayload(ws)
    const alpha = payload.providers.find(p => p.id === 'alpha')
    const beta = payload.providers.find(p => p.id === 'beta')
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    // 原 mock provider 的字段也不被并发写覆盖丢失。
    expect(payload.providers.find(p => p.id === 'mock')!.model).toBe('mock-model')
    await rm(root, { recursive: true, force: true })
  })

  it('M3：并发「保存凭据」与「更新设置」互不丢字段', async () => {
    const { root, ws } = await setup()
    await Promise.all([
      setCredential(ws, 'mock', 'concurrent-secret'),
      updateSettings(ws, { temperature: 0.7 }),
    ])
    const payload = await settingsPayload(ws)
    // llm.temperature 读取时被 provider 段显式值遮蔽（既有语义），直接看落盘。
    const raw = await readFile(join(ws, '.studyclaw', 'config.yaml'), 'utf8')
    expect(raw).toContain('temperature: 0.7')
    expect(payload.providers.find(p => p.id === 'mock')!.apiKeyConfigured).toBe(true)
    const config = await loadChatConfig(ws)
    expect(config.apiKey).toBe('concurrent-secret')
    await rm(root, { recursive: true, force: true })
  })

  it('M6：discoverModels 命中缓存不发请求，refresh 强制实时', async () => {
    let hits = 0
    const server: Server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'cached-model' }] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}/v1` : ''
    try {
      const first = await discoverModels({ baseUrl })
      expect(first.map(m => m.id)).toEqual(['cached-model'])
      expect(hits).toBe(1)
      // 同键第二次调用走缓存（TTL 内）。
      const second = await discoverModels({ baseUrl })
      expect(second.map(m => m.id)).toEqual(['cached-model'])
      expect(hits).toBe(1)
      // refresh: true 绕过缓存。
      const fresh = await discoverModels({ baseUrl, refresh: true })
      expect(fresh.map(m => m.id)).toEqual(['cached-model'])
      expect(hits).toBe(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
