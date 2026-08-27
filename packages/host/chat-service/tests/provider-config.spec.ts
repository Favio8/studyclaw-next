import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { activateProvider, deleteProvider, saveProvider } from '../src/settings.ts'
import { loadChatConfig } from '../src/config.ts'

async function readYaml(root: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(root, '.studyclaw', 'config.yaml'), 'utf8')
  const { default: yaml } = await import('js-yaml')
  return yaml.load(text) as Record<string, unknown>
}

describe('provider configuration write/read contract', () => {
  it('auto-activates the first serviceable provider on save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-provider-auto-'))
    try {
      const payload = await saveProvider(root, {
        id: 'my-gateway',
        name: 'My Gateway',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://gw.example/v1',
      })
      expect(payload.activeProviderId).toBe('my-gateway')
      const config = await readYaml(root)
      expect(config['active_provider']).toBe('my-gateway')
      expect((config['llm'] as Record<string, unknown>)['provider']).toBe('my-gateway')

      const resolved = await loadChatConfig(root)
      expect(resolved.providerId).toBe('my-gateway')
      expect(resolved.baseUrl).toBe('https://gw.example/v1')
      expect(resolved.model).toBe('deepseek-v4-flash')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not auto-activate an unserviceable provider (missing default model)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-provider-unserv-'))
    try {
      const payload = await saveProvider(root, {
        id: 'incomplete',
        name: 'Incomplete',
        model: '',
        baseUrl: 'https://gw.example/v1',
      })
      expect(payload.activeProviderId).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('activateProvider refuses an unserviceable profile with the missing field named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-provider-refuse-'))
    try {
      await saveProvider(root, { id: 'no-model', name: 'No Model', model: '', baseUrl: 'https://gw.example/v1' })
      await expect(activateProvider(root, 'no-model')).rejects.toThrow('未设置默认模型')
      await saveProvider(root, { id: 'no-base', name: 'No Base', model: 'm', baseUrl: null })
      await expect(activateProvider(root, 'no-base')).rejects.toThrow('缺少 Base URL')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loadChatConfig falls back to the first provider when the active pointer dangles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-provider-fallback-'))
    try {
      await saveProvider(root, { id: 'first', name: 'First', model: 'm1', baseUrl: 'https://one.example/v1/' })
      await saveProvider(root, { id: 'second', name: 'Second', model: 'm2', baseUrl: 'https://two.example/v1' })
      // 手工把指针改坏：模拟旧版本只写 providers、未写激活指针的工作区。
      const config = await readYaml(root)
      config['active_provider'] = 'deleted-long-ago'
      const { default: yaml } = await import('js-yaml')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(root, '.studyclaw', 'config.yaml'), yaml.dump(config), 'utf8')

      const resolved = await loadChatConfig(root)
      expect(resolved.providerId).toBe('first')
      // baseUrl 规范化：去尾部斜杠
      expect(resolved.baseUrl).toBe('https://one.example/v1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('judge 路由：judge_model/judge_reasoning_effort 解析与非法值兜底（判题提速 A 档）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-judge-route-'))
    try {
      await mkdir(join(root, '.studyclaw'), { recursive: true })
      await writeFile(join(root, '.studyclaw', 'config.yaml'), [
        'version: 1',
        'llm:',
        '  provider: mock',
        '  model: deepseek-v4-pro',
        '  judge_model: deepseek-v4-flash',
        '  judge_reasoning_effort: off',
      ].join('\n'), 'utf8')
      const resolved = await loadChatConfig(root)
      expect(resolved.model).toBe('deepseek-v4-pro')
      expect(resolved.judgeModel).toBe('deepseek-v4-flash')
      expect(resolved.judgeEffort).toBe('off')

      // 非法档位兜底为 null（判题路径再缺省 off）。
      await writeFile(join(root, '.studyclaw', 'config.yaml'), [
        'version: 1',
        'llm:',
        '  provider: mock',
        '  model: deepseek-v4-pro',
        '  judge_reasoning_effort: ultra',
      ].join('\n'), 'utf8')
      const fallback = await loadChatConfig(root)
      expect(fallback.judgeModel).toBeNull()
      expect(fallback.judgeEffort).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deleteProvider falls back to the first remaining provider, never a phantom route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-provider-delete-'))
    try {
      await saveProvider(root, { id: 'alpha', name: 'Alpha', model: 'm1', baseUrl: 'https://a.example/v1' })
      await saveProvider(root, { id: 'beta', name: 'Beta', model: 'm2', baseUrl: 'https://b.example/v1' })
      await activateProvider(root, 'beta')
      const payload = await deleteProvider(root, 'beta')
      expect(payload.activeProviderId).toBe('alpha')

      await deleteProvider(root, 'alpha')
      const config = await readYaml(root)
      expect(config['active_provider']).toBe('')
      expect(await loadChatConfig(root)).toMatchObject({ providerId: '', baseUrl: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
