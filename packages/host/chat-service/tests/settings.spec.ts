/**
 * Settings domain suite: config.yaml round-trip projection, provider CRUD,
 * credential storage, activation, partial update, and /models discovery
 * normalization (against a local mock server).
 */

import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function setup(): Promise<{ root: string; ws: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-settings-'))
  const ws = join(root, 'ws')
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

  it('setCredential writes credentials.json and backfills api_key_env', async () => {
    const { root, ws } = await setup()
    await setCredential(ws, 'mock', 'sk-test-123')
    const creds = JSON.parse(await readFile(join(ws, '.studyclaw', 'credentials.json'), 'utf8')) as Record<string, string>
    expect(creds['MOCK_API_KEY']).toBe('sk-test-123')
    const payload = await settingsPayload(ws)
    expect(payload.providers[0]!.apiKeyConfigured).toBe(true)
    expect(payload.providers[0]!.apiKeyEnv).toBe('MOCK_API_KEY')
    await rm(root, { recursive: true, force: true })
  })

  it('deleteProvider removes the record, credential, and falls back the active pointer', async () => {
    const { root, ws } = await setup()
    await setCredential(ws, 'mock', 'sk-test-123')
    const payload = await deleteProvider(ws, 'mock')
    expect(payload.providers).toHaveLength(0)
    expect(payload.activeProviderId).toBe('deepseek')
    const creds = JSON.parse(await readFile(join(ws, '.studyclaw', 'credentials.json'), 'utf8')) as Record<string, string>
    expect(creds['MOCK_API_KEY']).toBeUndefined()
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
})
