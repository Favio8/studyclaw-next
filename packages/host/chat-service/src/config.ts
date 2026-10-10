/**
 * Chat configuration resolution: reads the workspace's `.studyclaw/config.yaml`
 * (Python parity) plus credentials (env var first, then
 * `.studyclaw/credentials.json`). Produces the resolved connection facts the
 * DeepSeek adapter needs.
 * @module @studyclaw/chat-service/src/config
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { DEFAULT_PARSE_OPTIONS, type MineruTier, type ParseEngine, type ParseEngineOptions } from '@studyclaw/course-builder'

export interface ResolvedChatConfig {
  readonly providerId: string
  readonly model: string
  /** DSH-style per-Agent reasoning effort; absent means provider default. */
  readonly reasoningEffort?: string | null
  /** 判题专用模型（A 档提速）：config.yaml `llm.judge_model`；null=跟随主模型。 */
  readonly judgeModel?: string | null
  /** 判题思考档位：`llm.judge_reasoning_effort`；null=判题路径缺省 off（关思考）。 */
  readonly judgeEffort?: 'off' | 'low' | 'high' | 'max' | null
  /** 阅读解释/翻译专用模型：`llm.read_model`；null=跟随主模型。 */
  readonly readModel?: string | null
  /** 阅读动作思考档位：`llm.read_reasoning_effort`；null=阅读路径缺省 off。 */
  readonly readEffort?: 'off' | 'low' | 'high' | 'max' | null
  readonly baseUrl: string
  readonly apiKeyEnv: string | null
  readonly apiKey: string | null
  readonly temperature: number
  readonly maxConcurrency: number
  /** Per-request output cap（config.yaml `max_tokens`）；null=适配器默认。 */
  readonly maxTokens?: number | null
  readonly defaultMode: 'socratic' | 'quick' | 'feynman' | 'debug'
  /** 资料解析引擎选项（PRD 需求一；config.yaml `parse` 段，缺省 auto/basic/300s）。 */
  readonly parse: ParseEngineOptions
  readonly agentPreset?: string
  readonly permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly plugins?: Record<string, boolean>
}

interface ConfigYaml {
  readonly llm?: { provider?: string; model?: string; api_key_env?: string | null; api_base?: string | null; temperature?: number; max_concurrency?: number; max_tokens?: number | null; judge_model?: string | null; judge_reasoning_effort?: string | null; read_model?: string | null; read_reasoning_effort?: string | null }
  readonly active_provider?: string
  readonly providers?: Record<string, {
    readonly base_url?: string | null
    readonly model?: string
    readonly api_key_env?: string | null
    readonly temperature?: number
    readonly max_concurrency?: number
    readonly max_tokens?: number | null
  }>
  readonly ui?: { default_mode?: string }
  /** 资料解析（PRD 需求一）：engine=auto|mineru|builtin，tier=basic|standard|advanced。 */
  readonly parse?: { engine?: string; tier?: string; concurrency?: number; timeout_sec?: number }
  readonly agent?: { preset?: string }
  readonly permissions?: { preset?: string }
  readonly plugins?: Record<string, unknown>
}

/** Read one provider entry's connection facts from the config shape. */
export function providerFacts(config: ConfigYaml, providerId: string): {
  baseUrl: string | null
  model: string | null
  apiKeyEnv: string | null
  temperature: number | null
  maxConcurrency: number | null
  maxTokens: number | null
} {
  const entry = config.providers?.[providerId]
  return {
    baseUrl: entry?.base_url ?? null,
    model: entry?.model ?? null,
    apiKeyEnv: entry?.api_key_env ?? null,
    temperature: entry?.temperature ?? null,
    maxConcurrency: entry?.max_concurrency ?? null,
    maxTokens: entry?.max_tokens ?? null,
  }
}

/**
 * DSH live-default posture: an empty or dangling active pointer falls back to
 * the first declared provider, so a workspace whose `active_provider` was lost
 * (or never written) still resolves a usable route at read time. A workspace
 * with no `providers` map keeps the legacy `llm`-segment id as-is.
 */
function resolveActiveProvider(config: ConfigYaml): string {
  const declared = config.active_provider ?? config.llm?.provider ?? ''
  const providerIds = Object.keys(config.providers ?? {})
  if (providerIds.length === 0) return declared
  if (declared !== '' && providerIds.includes(declared)) return declared
  return providerIds[0] ?? ''
}

/** Trim whitespace and trailing slashes so `{base}/chat/completions` joins cleanly. */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** parse.engine 白名单归一：未知值（含历史拼写）回落 auto。 */
function normalizeParseEngine(value: unknown): ParseEngine {
  return value === 'mineru' || value === 'builtin' ? value : 'auto'
}

/** parse.tier 白名单归一：flash 不开放给课程构建，未知值回落 basic。 */
function normalizeParseTier(value: unknown): MineruTier {
  return value === 'standard' || value === 'advanced' ? value : 'basic'
}

/** 解析 parse 段为引擎选项（缺省 auto/basic/300s/并发1；并发钳 1~2——每个
 *  mineru-kit 进程各自加载模型，内存敏感，不做按硬件探测的自动调并发）。 */
export function resolveParseOptions(config: ConfigYaml): ParseEngineOptions {
  const parse = config.parse ?? {}
  const concurrency = typeof parse.concurrency === 'number' && Number.isFinite(parse.concurrency)
    ? Math.round(parse.concurrency)
    : DEFAULT_PARSE_OPTIONS.concurrency
  const timeoutSec = typeof parse.timeout_sec === 'number' && Number.isFinite(parse.timeout_sec)
    ? Math.round(parse.timeout_sec)
    : DEFAULT_PARSE_OPTIONS.timeoutSec
  return {
    engine: normalizeParseEngine(parse.engine),
    tier: normalizeParseTier(parse.tier),
    timeoutSec: Math.max(30, Math.min(3600, timeoutSec)),
    concurrency: Math.max(1, Math.min(2, concurrency)),
  }
}

/**
 * Load and resolve the active chat config for one workspace.
 * @param workspaceRoot - The workspace root holding `.studyclaw/config.yaml`.
 * @returns resolved connection facts; `baseUrl`/`apiKey` may be null when
 * unconfigured (the host reports a clear error at chat time).
 */
export async function loadChatConfig(workspaceRoot: string, selection?: { providerId?: string; model?: string }): Promise<ResolvedChatConfig> {
  const configPath = join(workspaceRoot, '.studyclaw', 'config.yaml')
  const raw = await readFile(configPath, 'utf8').catch(() => null)
  if (raw === null) {
    return {
      providerId: '',
      model: '',
      reasoningEffort: null,
      judgeModel: null,
      judgeEffort: null,
      readModel: null,
      readEffort: null,
      baseUrl: '',
      apiKeyEnv: null,
      apiKey: null,
      temperature: 0.3,
      maxConcurrency: 4,
      maxTokens: null,
      defaultMode: 'socratic',
      parse: DEFAULT_PARSE_OPTIONS,
      agentPreset: 'studyclaw-learning',
      permissionPreset: 'workspace-write',
      plugins: {},
    }
  }
  const config = yaml.load(raw) as ConfigYaml
  const providerId = selection?.providerId ?? resolveActiveProvider(config)
  const direct = providerFacts(config, providerId)
  const baseUrl = normalizeBaseUrl(direct.baseUrl ?? config.llm?.api_base ?? '')
  const model = selection?.model ?? direct.model ?? config.llm?.model ?? ''
  const apiKeyEnv = direct.apiKeyEnv ?? config.llm?.api_key_env ?? null
  const apiKey = await resolveCredential(workspaceRoot, providerId, apiKeyEnv)
  const temperature = direct.temperature ?? config.llm?.temperature ?? 0.3
  const maxConcurrency = direct.maxConcurrency ?? config.llm?.max_concurrency ?? 4
  const maxTokens = direct.maxTokens ?? config.llm?.max_tokens ?? null
  const defaultMode = config.ui?.default_mode === 'quick' || config.ui?.default_mode === 'feynman' || config.ui?.default_mode === 'debug'
    ? config.ui.default_mode
    : 'socratic'
  const permissionPreset = config.permissions?.preset === 'read-only' || config.permissions?.preset === 'danger-full-access'
    ? config.permissions.preset
    : 'workspace-write'
  const plugins: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(config.plugins ?? {})) if (typeof enabled === 'boolean') plugins[id] = enabled
  const judgeEffortRaw = config.llm?.judge_reasoning_effort
  const judgeEffort = judgeEffortRaw === 'off' || judgeEffortRaw === 'low' || judgeEffortRaw === 'high' || judgeEffortRaw === 'max'
    ? judgeEffortRaw
    : null
  const readEffortRaw = config.llm?.read_reasoning_effort
  const readEffort = readEffortRaw === 'off' || readEffortRaw === 'low' || readEffortRaw === 'high' || readEffortRaw === 'max'
    ? readEffortRaw
    : null
  return {
    providerId,
    model,
    reasoningEffort: null,
    judgeModel: config.llm?.judge_model ?? null,
    judgeEffort,
    readModel: config.llm?.read_model ?? null,
    readEffort,
    baseUrl,
    apiKeyEnv,
    apiKey,
    temperature,
    maxConcurrency,
    maxTokens,
    defaultMode,
    parse: resolveParseOptions(config),
    agentPreset: config.agent?.preset === 'general' ? 'general' : 'studyclaw-learning',
    permissionPreset,
    plugins,
  }
}

/** Credential resolution: env var first, then `.studyclaw/credentials.json`. */
function credentialsPathOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.studyclaw', 'credentials.json')
}

async function resolveCredential(workspaceRoot: string, providerId: string, apiKeyEnv: string | null): Promise<string | null> {
  if (apiKeyEnv !== null) {
    const envValue = process.env[apiKeyEnv]
    if (typeof envValue === 'string' && envValue !== '') return envValue
  }
  const credsRaw = await readFile(credentialsPathOf(workspaceRoot), 'utf8').catch(() => null)
  if (credsRaw === null || credsRaw.trim() === '') return null
  let creds: Record<string, unknown>
  try {
    // P0-2：凭据为 AES-GCM 密文；legacy 明文由 settings 层读取时自动迁移，
    // 这里只需透明解密。解密失败按"未配置"降级而不是让所有 chat 崩溃，
    // 但必须留痕（L7）：master.key 与工作区错位时静默降级会让排障变成猜谜。
    const { unsealCredentials } = await import('./secret-box.ts')
    creds = (await unsealCredentials(credsRaw)).data
  } catch (error) {
    console.warn(`[config] credentials.json 解密失败，本次按未配置凭据处理：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  // Settings writes credentials under the generated apiKeyEnv ref
  // (e.g. `MOCK_API_KEY`), while older workspaces may still use the
  // provider id or a `default` entry. Accept all compatible keys without
  // exposing the secret in the resolved config payload.
  for (const key of [apiKeyEnv, providerId, providerId.replace(/^openai\//, ''), 'default']) {
    if (key === null) continue
    const value = creds[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const nested = creds['providers'] as Record<string, unknown> | undefined
  const nestedValue = nested?.[providerId]
  if (typeof nestedValue === 'string' && nestedValue !== '') return nestedValue
  return null
}
