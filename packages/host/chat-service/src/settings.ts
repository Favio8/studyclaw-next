/**
 * Settings domain: full read/write over the workspace's `.studyclaw/config.yaml`
 * (Python parity) plus credentials, the built-in provider catalog, model
 * discovery, and provider CRUD/activation. Wire shapes mirror the Python
 * `_settings_payload` / `ProviderModelPayload` projections.
 * @module @studyclaw/chat-service/src/settings
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { sealCredentials, unsealCredentials, writeFileAtomicRestricted } from './secret-box.ts'

export interface ProviderModelPayload {
  readonly id: string
  readonly name: string
  readonly contextWindow: number | null
  readonly maxTokens: number | null
}

export interface ProviderPayload {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly baseUrl: string | null
  readonly apiKeyEnv: string | null
  readonly apiKeyConfigured: boolean
  readonly temperature: number
  readonly maxConcurrency: number
  readonly models: ProviderModelPayload[]
}

export interface AgentPresetPayload {
  readonly id: string
  readonly name: string
  readonly description: string
}

export interface PermissionPresetPayload {
  readonly id: string
  readonly name: string
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'deny' | 'ask' | 'never'
  readonly description: string
}

export interface PluginInventoryPayload {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly source: 'builtin' | 'workspace'
  readonly reason?: string
}

export interface SettingsPayload {
  readonly version: number
  readonly activeProviderId: string
  readonly llm: {
    readonly provider: string
    readonly model: string
    readonly apiKeyEnv: string | null
    readonly apiBase: string | null
    readonly temperature: number
    readonly maxConcurrency: number
    readonly apiKeyConfigured: boolean
  }
  readonly providers: ProviderPayload[]
  readonly ui: { readonly defaultMode: string }
  readonly agent: { readonly preset: string; readonly presets: AgentPresetPayload[] }
  readonly permissions: { readonly preset: string; readonly presets: PermissionPresetPayload[] }
  readonly plugins: { readonly inventory: PluginInventoryPayload[] }
}

interface ProviderConfigYaml {
  readonly id?: string
  readonly name?: string
  readonly model?: string
  readonly base_url?: string | null
  readonly api_key_env?: string | null
  readonly temperature?: number
  readonly max_concurrency?: number
  readonly models?: Array<{ id?: string; name?: string; context_window?: number | null; max_tokens?: number | null }>
}

interface ConfigYaml {
  version?: number
  llm?: {
    provider?: string
    model?: string
    api_key_env?: string | null
    api_base?: string | null
    temperature?: number
    max_concurrency?: number
  }
  providers?: Record<string, ProviderConfigYaml>
  active_provider?: string
  ui?: { default_mode?: string }
  agent?: { preset?: string }
  permissions?: { preset?: string }
  plugins?: Record<string, unknown>
}

const AGENT_PRESETS: AgentPresetPayload[] = [
  { id: 'studyclaw-learning', name: 'StudyClaw 学习导师', description: '课程上下文与学习工具 preset' },
  { id: 'general', name: '通用 Agent', description: '不注入课程专属上下文' },
]

const PERMISSION_PRESETS: PermissionPresetPayload[] = [
  { id: 'read-only', name: '只读', sandboxMode: 'read-only', approvalPolicy: 'deny', description: '读取和搜索自动执行，所有写入拒绝' },
  { id: 'workspace-write', name: '工作区写入', sandboxMode: 'workspace-write', approvalPolicy: 'ask', description: '写入、命令和网络操作需要审批' },
  { id: 'danger-full-access', name: '完全访问', sandboxMode: 'danger-full-access', approvalPolicy: 'never', description: '仅适用于受信任的隔离部署' },
]

function pluginInventory(config: ConfigYaml): PluginInventoryPayload[] {
  const configured = config.plugins ?? {}
  return [
    { id: 'learning', name: 'Learning preset', enabled: configured['learning'] !== false, source: 'builtin' },
    { id: 'generic-tools', name: 'Generic tools', enabled: configured['generic-tools'] !== false, source: 'builtin' },
    { id: 'sandbox', name: 'Sandbox provider', enabled: configured['sandbox'] === true, source: 'builtin', ...(configured['sandbox'] === true ? {} : { reason: '未配置隔离 Provider' }) },
    { id: 'lsp', name: 'LSP provider', enabled: configured['lsp'] === true, source: 'builtin', ...(configured['lsp'] === true ? {} : { reason: '未配置 LSP Provider' }) },
  ]
}

function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.studyclaw', 'config.yaml')
}

function credentialsPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.studyclaw', 'credentials.json')
}

async function readConfig(workspaceRoot: string): Promise<ConfigYaml> {
  const raw = await readFile(configPath(workspaceRoot), 'utf8').catch(() => null)
  if (raw === null) return {}
  const parsed = yaml.load(raw)
  return typeof parsed === 'object' && parsed !== null ? parsed as ConfigYaml : {}
}

async function writeConfig(workspaceRoot: string, config: ConfigYaml): Promise<void> {
  const path = configPath(workspaceRoot)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(workspaceRoot, '.studyclaw'), { recursive: true })
  const tmp = path + '.tmp'
  const text = yaml.dump(config, { sortKeys: false, noRefs: true })
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** Workspace-wide read/modify/write serialization for credentials.json. */
const credentialLocks = new Map<string, Promise<unknown>>()

/** Run `fn` while holding the workspace credential lock (SEC-7：并发保存两个
 * provider 的 key 不再互相丢更新)。 */
async function withCredentialLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(workspaceRoot) ?? Promise.resolve()
  const current = previous.then(fn, fn)
  credentialLocks.set(workspaceRoot, current)
  try {
    return await current
  } finally {
    if (credentialLocks.get(workspaceRoot) === current) credentialLocks.delete(workspaceRoot)
  }
}

/**
 * Read `.studyclaw/credentials.json`. Legacy plaintext files are transparently
 * re-sealed on first successful read so the migration needs no explicit step.
 */
async function readCredentials(workspaceRoot: string): Promise<Record<string, string>> {
  const raw = await readFile(credentialsPath(workspaceRoot), 'utf8').catch(() => null)
  if (raw === null || raw.trim() === '') return {}
  let parsed: Awaited<ReturnType<typeof unsealCredentials>>
  try {
    parsed = await unsealCredentials(raw)
  } catch {
    // 密钥不匹配或文件损坏时宁可报错也不能当作“未配置密钥”静默继续。
    throw new Error('credentials.json 解密失败（master.key 与该工作区凭据不匹配？）')
  }
  if (parsed.wasPlaintext && Object.keys(parsed.data).length > 0) {
    await writeCredentials(workspaceRoot, parsed.data).catch(() => undefined)
  }
  return parsed.data
}

/** Seal + atomic owner-only write (0600/fsync)：分享工作区不再带走明文 key。 */
async function writeCredentials(workspaceRoot: string, credentials: Record<string, string>): Promise<void> {
  const sealed = await sealCredentials(credentials)
  await writeFileAtomicRestricted(credentialsPath(workspaceRoot), sealed)
}

/** DSH key-ref rule: uppercase, non-alnum → underscore, `_API_KEY` suffix. */
export function deriveKeyRef(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

async function credentialConfigured(workspaceRoot: string, ref: string | null | undefined): Promise<boolean> {
  if (ref === null || ref === undefined || ref === '') return false
  const envValue = process.env[ref]
  if (typeof envValue === 'string' && envValue !== '') return true
  return (await readCredentials(workspaceRoot))[ref] !== undefined
}

/** The active provider id: explicit `active_provider`, else the llm segment. */
export function activeProviderId(config: ConfigYaml): string {
  return config.active_provider ?? config.llm?.provider ?? ''
}

function toModelPayload(models: Array<{ id?: string; name?: string; context_window?: number | null; max_tokens?: number | null }> | undefined): ProviderModelPayload[] {
  return (models ?? []).map(model => ({
    id: model.id ?? '',
    name: model.name ?? model.id ?? '',
    contextWindow: typeof model.context_window === 'number' && model.context_window > 0 ? model.context_window : null,
    maxTokens: typeof model.max_tokens === 'number' && model.max_tokens > 0 ? model.max_tokens : null,
  }))
}

async function providerPayload(workspaceRoot: string, id: string, provider: ProviderConfigYaml): Promise<ProviderPayload> {
  const ref = provider.api_key_env ?? null
  return {
    id,
    name: provider.name ?? id,
    model: provider.model ?? '',
    baseUrl: provider.base_url ?? null,
    apiKeyEnv: ref,
    apiKeyConfigured: await credentialConfigured(workspaceRoot, ref),
    temperature: provider.temperature ?? 0.3,
    maxConcurrency: provider.max_concurrency ?? 4,
    models: toModelPayload(provider.models),
  }
}

/** Full settings projection (Python `_settings_payload` parity). */
export async function settingsPayload(workspaceRoot: string): Promise<SettingsPayload> {
  const config = await readConfig(workspaceRoot)
  const active = activeProviderId(config)
  const activeProvider = active !== '' ? config.providers?.[active] : undefined
  const llmRef = activeProvider?.api_key_env ?? config.llm?.api_key_env ?? null
  const providers: ProviderPayload[] = []
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    providers.push(await providerPayload(workspaceRoot, id, provider))
  }
  return {
    version: config.version ?? 1,
    activeProviderId: active,
    llm: {
      provider: active,
      model: activeProvider?.model ?? config.llm?.model ?? '',
      apiKeyEnv: llmRef,
      apiBase: activeProvider?.base_url ?? config.llm?.api_base ?? null,
      temperature: activeProvider?.temperature ?? config.llm?.temperature ?? 0.3,
      maxConcurrency: activeProvider?.max_concurrency ?? config.llm?.max_concurrency ?? 4,
      apiKeyConfigured: await credentialConfigured(workspaceRoot, llmRef),
    },
    providers,
    ui: { defaultMode: config.ui?.default_mode === 'quick' || config.ui?.default_mode === 'feynman' || config.ui?.default_mode === 'debug' ? config.ui.default_mode : 'socratic' },
    agent: { preset: AGENT_PRESETS.some(item => item.id === config.agent?.preset) ? config.agent!.preset! : 'studyclaw-learning', presets: AGENT_PRESETS },
    permissions: { preset: PERMISSION_PRESETS.some(item => item.id === config.permissions?.preset) ? config.permissions!.preset! : 'workspace-write', presets: PERMISSION_PRESETS },
    plugins: { inventory: pluginInventory(config) },
  }
}

/** Built-in catalog entry (Python provider_catalog parity). */
export interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly baseUrl: string | null
  readonly models: ProviderModelPayload[]
}

export function providerCatalog(): CatalogEntry[] {
  return [
    {
      id: 'deepseek',
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com',
      models: [],
    },
    {
      id: 'sensenova',
      name: 'SenseNova 日日新',
      baseUrl: 'https://token.sensenova.cn/v1',
      models: [
        { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', contextWindow: null, maxTokens: null },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（商汤托管）', contextWindow: null, maxTokens: null },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（商汤托管）', contextWindow: null, maxTokens: null },
      ],
    },
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
    { id: 'custom', name: '自定义 OpenAI 兼容', baseUrl: null, models: [] },
  ]
}

/** Normalize a `/models` response (Python `_parse_models_payload` parity). */
export function parseModelsPayload(payload: unknown): ProviderModelPayload[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('端点返回的不是 JSON 对象')
  }
  const rows = (payload as { data?: unknown }).data
  if (!Array.isArray(rows)) throw new Error('端点响应缺少 data 数组')
  const models: ProviderModelPayload[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as Record<string, unknown>
    const id = String(entry['id'] ?? '').trim()
    if (id === '') continue
    const context = entry['context_length'] ?? entry['context_window']
    const maxOut = entry['max_output_length'] ?? entry['max_tokens']
    models.push({
      id,
      name: String(entry['name'] ?? '').trim() || id,
      contextWindow: typeof context === 'number' && context > 0 ? context : null,
      maxTokens: typeof maxOut === 'number' && maxOut > 0 ? maxOut : null,
    })
  }
  return models
}

/**
 * Model-endpoint probe hardening (SEC-2):
 * - only http(s), no embedded credentials;
 * - `apiKeyEnv` must look like an API-key variable (provider prefix or
 *   *_API_KEY / *_API_TOKEN suffix) so arbitrary env values — e.g. PATH —
 *   can never be attached as Bearer credentials to an attacker URL;
 * - error messages never echo the caller-supplied target URL.
 * Loopback/private hosts stay allowed: local model servers (Ollama 等) are a
 * first-class use case, and cross-site browser callers are already blocked
 * by the serve 入口的 Origin 门禁.
 */
const API_KEY_ENV_RE = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|GOOGLE|GEMINI|DASHSCOPE|MOONSHOT|ZHIPU|SENSENOVA|OPENROUTER|SILICONFLOW|CUSTOM|STUDYCLAW)_[A-Z0-9_]+$|^[A-Z][A-Z0-9_]*_(?:API_KEY|API_TOKEN)$/

/** Validate and normalize a user-supplied model endpoint base URL. */
export function validateModelBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Base URL 不是合法的 URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Base URL 只支持 http/https 协议')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Base URL 不允许内嵌用户名或密码')
  }
  return trimmed.replace(/\/+$/, '')
}

/** Probe `GET {baseUrl}/models` (read-only, no persistence). */
export async function discoverModels(input: { baseUrl: string; apiKey?: string | null; apiKeyEnv?: string | null }): Promise<ProviderModelPayload[]> {
  const base = validateModelBaseUrl(input.baseUrl)
  if (base === '') throw new Error('Base URL 不能为空')
  let apiKey = input.apiKey?.trim() ?? null
  if (
    apiKey === null
    && input.apiKeyEnv !== null && input.apiKeyEnv !== undefined && input.apiKeyEnv.trim() !== ''
  ) {
    if (!API_KEY_ENV_RE.test(input.apiKeyEnv.trim())) {
      throw new Error('环境变量名不在允许列表内（仅支持各 Provider 的 API_KEY 命名）')
    }
    apiKey = process.env[input.apiKeyEnv.trim()] ?? null
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey !== null && apiKey !== '') headers['Authorization'] = `Bearer ${apiKey}`
  let response: Response
  try {
    response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) })
  } catch {
    // 不回显目标地址：错误细节本身就是内网探测的回显信道。
    throw new Error('无法连接模型端点（请检查 Base URL 与网络）')
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '，请检查 API Key 是否正确' : ''
    throw new Error(`端点返回 HTTP ${response.status}${hint}`)
  }
  return parseModelsPayload(await response.json())
}

/** Duplicate-provider creation guard (409 in the RPC envelope). */
export class ProviderExistsError extends Error {
  readonly providerId: string
  constructor(providerId: string) {
    super(`Provider ${providerId} 已存在（覆盖前请先确认）`)
    this.name = 'ProviderExistsError'
    this.providerId = providerId
  }
}

/**
 * Save one provider with **merge semantics** (DSH `settings.mutate` parity):
 * - `temperature` / `maxConcurrency` / `models` are optional; when omitted
 *   the existing value survives (editing a card must not reset fields the
 *   card does not show, nor drop keys hand-edited in config.yaml).
 * - `models: null` keeps the current list; `models: []` clears it; a
 *   non-empty array replaces it wholesale.
 * - Unknown YAML keys on the profile survive a rebuild (spread first).
 * - Creating an id that already exists requires `overwrite: true`, else a
 *   `ProviderExistsError` (frontend turns it into a confirm dialog).
 */
export async function saveProvider(workspaceRoot: string, input: {
  id: string
  name: string
  model: string
  baseUrl: string | null
  temperature?: number
  maxConcurrency?: number
  models?: Array<{ id: string; name: string; contextWindow: number | null; maxTokens: number | null }> | null
  overwrite?: boolean
}): Promise<SettingsPayload> {
  const id = input.id.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error('Provider ID 必须以小写字母开头且只含小写字母/数字/连字符')
  }
  const config = await readConfig(workspaceRoot)
  const existing = config.providers?.[id]
  if (existing !== undefined && input.overwrite !== true) {
    throw new ProviderExistsError(id)
  }
  const providers: Record<string, ProviderConfigYaml> = { ...(config.providers ?? {}) }
  providers[id] = {
    // 先展开既有 profile：未知键与未改字段原样保留（merge，非重建）。
    ...(existing ?? {}),
    id,
    name: input.name.trim(),
    model: input.model.trim(),
    base_url: input.baseUrl?.trim() || null,
    api_key_env: existing?.api_key_env ?? null,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxConcurrency !== undefined ? { max_concurrency: input.maxConcurrency } : {}),
    ...(input.models !== undefined && input.models !== null ? {
      models: input.models.map(model => ({
        id: model.id,
        name: model.name,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      })),
    } : {}),
  }
  let nextConfig: ConfigYaml = { ...config, providers }
  // DSH write-time posture: a saved provider the reader can never resolve is
  // the top misconfiguration, so the first serviceable save auto-activates
  // (the reader only consults `active_provider` / `llm.provider`).
  const active = activeProviderId(nextConfig)
  const saved = providers[id]
  if ((active === '' || providers[active] === undefined) && saved.model !== '' && (saved.base_url ?? '') !== '') {
    nextConfig = { ...nextConfig, active_provider: id, llm: { ...nextConfig.llm, provider: id } }
  }
  await writeConfig(workspaceRoot, nextConfig)
  return settingsPayload(workspaceRoot)
}

/** Remove a provider; the active pointer falls back to the first remaining. */
export async function deleteProvider(workspaceRoot: string, providerId: string): Promise<SettingsPayload> {
  const config = await readConfig(workspaceRoot)
  const existing = config.providers?.[providerId]
  if (existing === undefined) throw new Error(`Provider ${providerId} 不存在`)
  if (existing.api_key_env !== null && existing.api_key_env !== undefined) {
    const credentials = await readCredentials(workspaceRoot)
    delete credentials[existing.api_key_env]
    await writeCredentials(workspaceRoot, credentials)
  }
  const providers = { ...(config.providers ?? {}) }
  delete providers[providerId]
  // The active pointer may be the explicit field or the llm-segment synthesis.
  // Removing the active provider falls back to the first remaining provider;
  // an empty pointer keeps the reader's first-entry fallback meaningful (no
  // phantom 'deepseek' route that no profile backs).
  const active = config.active_provider ?? config.llm?.provider ?? ''
  if (active === providerId) {
    const fallback = Object.keys(providers)[0] ?? ''
    const nextConfig: ConfigYaml = { ...config, providers, active_provider: fallback, llm: { ...config.llm, provider: fallback } }
    await writeConfig(workspaceRoot, nextConfig)
    return settingsPayload(workspaceRoot)
  }
  await writeConfig(workspaceRoot, { ...config, providers })
  return settingsPayload(workspaceRoot)
}

/** Activate one provider (the active pointer + llm display segment). */
export async function activateProvider(workspaceRoot: string, providerId: string): Promise<SettingsPayload> {
  const config = await readConfig(workspaceRoot)
  const provider = config.providers?.[providerId]
  if (provider === undefined) throw new Error(`Provider ${providerId} 不存在`)
  // DSH write-time refusal: activation is what makes build/default chat use
  // the profile, so refuse unserviceable ones with the missing field named.
  const label = provider.name ?? providerId
  if ((provider.model ?? '') === '') throw new Error(`供应商 ${label} 未设置默认模型，激活前请在编辑器中选择`)
  if ((provider.base_url ?? '') === '') throw new Error(`供应商 ${label} 缺少 Base URL，激活前请在编辑器中补全`)
  await writeConfig(workspaceRoot, { ...config, active_provider: providerId, llm: { ...config.llm, provider: providerId } })
  return settingsPayload(workspaceRoot)
}

/** Store one provider's API key into `.studyclaw/credentials.json`. */
export async function setCredential(workspaceRoot: string, providerId: string, apiKey: string): Promise<SettingsPayload> {
  const config = await readConfig(workspaceRoot)
  const provider = config.providers?.[providerId]
  if (provider === undefined) throw new Error(`Provider ${providerId} 不存在`)
  const ref = deriveKeyRef(providerId)
  await withCredentialLock(workspaceRoot, async () => {
    const credentials = await readCredentials(workspaceRoot)
    credentials[ref] = apiKey
    await writeCredentials(workspaceRoot, credentials)
  })
  const providers = { ...(config.providers ?? {}) }
  providers[providerId] = { ...provider, api_key_env: ref }
  await writeConfig(workspaceRoot, { ...config, providers })
  return settingsPayload(workspaceRoot)
}

/** Partial update: llm segment fields and/or ui.default_mode. */
export async function updateSettings(workspaceRoot: string, partial: {
  provider?: string
  model?: string
  apiKeyEnv?: string
  apiBase?: string | null
  temperature?: number
  maxConcurrency?: number
  defaultMode?: string
  agentPreset?: string
  permissionPreset?: string
  plugins?: Record<string, boolean>
}): Promise<SettingsPayload> {
  const config = await readConfig(workspaceRoot)
  const llm = config.llm ?? {}
  const nextLlm: NonNullable<ConfigYaml['llm']> = { ...llm }
  if (partial.provider !== undefined) nextLlm.provider = partial.provider.trim()
  if (partial.model !== undefined) nextLlm.model = partial.model.trim()
  if (partial.apiKeyEnv !== undefined) {
    const value = partial.apiKeyEnv.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error('API key 环境变量名必须是字母、数字和下划线组成，且不能以数字开头')
    }
    nextLlm.api_key_env = value
  }
  if (partial.apiBase !== undefined) nextLlm.api_base = partial.apiBase === null ? null : partial.apiBase.trim() || null
  if (partial.temperature !== undefined) nextLlm.temperature = partial.temperature
  if (partial.maxConcurrency !== undefined) nextLlm.max_concurrency = partial.maxConcurrency
  const nextUi: NonNullable<ConfigYaml['ui']> = { ...(config.ui ?? {}) }
  if (partial.defaultMode !== undefined) {
    if (!['socratic', 'quick', 'feynman', 'debug'].includes(partial.defaultMode)) {
      throw new Error('默认学习模式无效')
    }
    nextUi.default_mode = partial.defaultMode
  }
  const nextAgent = { ...(config.agent ?? {}) }
  if (partial.agentPreset !== undefined) {
    if (!AGENT_PRESETS.some(item => item.id === partial.agentPreset)) throw new Error('Agent preset 无效')
    nextAgent.preset = partial.agentPreset
  }
  const nextPermissions = { ...(config.permissions ?? {}) }
  if (partial.permissionPreset !== undefined) {
    if (!PERMISSION_PRESETS.some(item => item.id === partial.permissionPreset)) throw new Error('权限 preset 无效')
    nextPermissions.preset = partial.permissionPreset
  }
  const nextPlugins = { ...(config.plugins ?? {}) }
  if (partial.plugins !== undefined) {
    for (const [id, enabled] of Object.entries(partial.plugins)) {
      if (!['learning', 'generic-tools', 'sandbox', 'lsp'].includes(id)) throw new Error(`插件不存在: ${id}`)
      nextPlugins[id] = enabled
    }
  }
  const changed = JSON.stringify(nextLlm) !== JSON.stringify(llm) || JSON.stringify(nextUi) !== JSON.stringify(config.ui ?? {})
    || JSON.stringify(nextAgent) !== JSON.stringify(config.agent ?? {}) || JSON.stringify(nextPermissions) !== JSON.stringify(config.permissions ?? {})
    || JSON.stringify(nextPlugins) !== JSON.stringify(config.plugins ?? {})
  if (!changed) throw new Error('没有需要更新的设置字段')
  await writeConfig(workspaceRoot, { ...config, llm: nextLlm, ui: nextUi, agent: nextAgent, permissions: nextPermissions, plugins: nextPlugins })
  return settingsPayload(workspaceRoot)
}
