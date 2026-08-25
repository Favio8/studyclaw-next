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

export interface ResolvedChatConfig {
  readonly providerId: string
  readonly model: string
  /** DSH-style per-Agent reasoning effort; absent means provider default. */
  readonly reasoningEffort?: string | null
  readonly baseUrl: string
  readonly apiKeyEnv: string | null
  readonly apiKey: string | null
  readonly temperature: number
  readonly maxConcurrency: number
  readonly defaultMode: 'socratic' | 'quick' | 'feynman' | 'debug'
  readonly agentPreset?: string
  readonly permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly plugins?: Record<string, boolean>
}

interface ConfigYaml {
  readonly llm?: { provider?: string; model?: string; api_key_env?: string | null; api_base?: string | null; temperature?: number; max_concurrency?: number }
  readonly active_provider?: string
  readonly providers?: Record<string, {
    readonly base_url?: string | null
    readonly model?: string
    readonly api_key_env?: string | null
    readonly temperature?: number
    readonly max_concurrency?: number
  }>
  readonly ui?: { default_mode?: string }
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
} {
  const entry = config.providers?.[providerId]
  return {
    baseUrl: entry?.base_url ?? null,
    model: entry?.model ?? null,
    apiKeyEnv: entry?.api_key_env ?? null,
    temperature: entry?.temperature ?? null,
    maxConcurrency: entry?.max_concurrency ?? null,
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
      baseUrl: '',
      apiKeyEnv: null,
      apiKey: null,
      temperature: 0.3,
      maxConcurrency: 4,
      defaultMode: 'socratic',
      agentPreset: 'studyclaw-learning',
      permissionPreset: 'workspace-write',
      plugins: {},
    }
  }
  const config = yaml.load(raw) as ConfigYaml
  const providerId = selection?.providerId ?? config.active_provider ?? config.llm?.provider ?? ''
  const direct = providerFacts(config, providerId)
  const baseUrl = direct.baseUrl ?? config.llm?.api_base ?? ''
  const model = selection?.model ?? direct.model ?? config.llm?.model ?? ''
  const apiKeyEnv = direct.apiKeyEnv ?? config.llm?.api_key_env ?? null
  const apiKey = await resolveCredential(workspaceRoot, providerId, apiKeyEnv)
  const temperature = direct.temperature ?? config.llm?.temperature ?? 0.3
  const maxConcurrency = direct.maxConcurrency ?? config.llm?.max_concurrency ?? 4
  const defaultMode = config.ui?.default_mode === 'quick' || config.ui?.default_mode === 'feynman' || config.ui?.default_mode === 'debug'
    ? config.ui.default_mode
    : 'socratic'
  const permissionPreset = config.permissions?.preset === 'read-only' || config.permissions?.preset === 'danger-full-access'
    ? config.permissions.preset
    : 'workspace-write'
  const plugins: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(config.plugins ?? {})) if (typeof enabled === 'boolean') plugins[id] = enabled
  return {
    providerId,
    model,
    reasoningEffort: null,
    baseUrl,
    apiKeyEnv,
    apiKey,
    temperature,
    maxConcurrency,
    defaultMode,
    agentPreset: config.agent?.preset === 'general' ? 'general' : 'studyclaw-learning',
    permissionPreset,
    plugins,
  }
}

/** Credential resolution: env var first, then `.studyclaw/credentials.json`. */
async function resolveCredential(workspaceRoot: string, providerId: string, apiKeyEnv: string | null): Promise<string | null> {
  if (apiKeyEnv !== null) {
    const envValue = process.env[apiKeyEnv]
    if (typeof envValue === 'string' && envValue !== '') return envValue
  }
  const credentialsPath = join(workspaceRoot, '.studyclaw', 'credentials.json')
  const credsRaw = await readFile(credentialsPath, 'utf8').catch(() => null)
  if (credsRaw !== null) {
    try {
      const creds = JSON.parse(credsRaw) as Record<string, unknown>
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
    } catch {
      // Malformed credentials file: treated as unconfigured.
    }
  }
  return null
}
