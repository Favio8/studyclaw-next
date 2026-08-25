/**
 * ToolLlmClient adapter over the dsh DeepSeekAdapter (fetch+SSE OpenAI-
 * compatible). Translates the session loop's plain OpenAI-shaped messages
 * into the dsh Message vocabulary, streams chunks as text deltas, and
 * emits the final tool-call batch. Native reasoning deltas feed the same
 * text stream (the splitter separates `<think>`).
 * @module @studyclaw/chat-service/src/adapter
 */

import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, type ContentBlock, type LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DeepSeekAdapter, type DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { ToolCall, ToolLlmClient } from '@studyclaw/session'
import type { StructuredCallClient } from '@studyclaw/course-builder'
import type { ResolvedChatConfig } from './config.ts'

/** Static anonymous id (dsh adapters only use it for telemetry binding). */
const ANONYMOUS_USER = 'anonymous'

/**
 * Build the tool-loop LLM client for one resolved config. The adapter is
 * constructed directly (no cordis plugin graph); options are re-read per
 * operation so a config change reaches the next request.
 */
export function createDeepSeekToolClient(config: ResolvedChatConfig): ToolLlmClient & StructuredCallClient {
  const adapter = createDeepSeekAdapter(config)
  return new DeepSeekToolClient(adapter, config)
}

/** Return the adapter-owned effort choices for one provider/model route. */
export async function reasoningEffortsForConfig(config: ResolvedChatConfig, model = config.model): Promise<Array<{ id: string; name: string; description?: string }>> {
  const adapter = createDeepSeekAdapter(config)
  const resolved = await adapter.resolveModel(config.providerId || 'studyclaw', model)
  return (resolved.reasoning?.efforts ?? []).map((effort: LlmReasoningEffortInfo) => ({
    id: String(effort.id),
    name: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
  }))
}

function createDeepSeekAdapter(config: ResolvedChatConfig): DeepSeekAdapter {
  const connection = (): DeepSeekConnectionOptions => ({
    baseURL: config.baseUrl,
    apiKeyEnv: (config.apiKeyEnv ?? '') as CredentialRef,
    defaults: {
      ...(config.reasoningEffort === 'off' || config.reasoningEffort === 'low' || config.reasoningEffort === 'high' || config.reasoningEffort === 'max'
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    },
    maxTokens: 8192,
    defaultContextWindow: 128_000,
    models: [],
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 250,
      maxDelayMs: 4_000,
      jitterRatio: 0.2,
    },
  })
  return new DeepSeekAdapter({
    options: connection,
    resolveApiKey: async (facts) => {
      const key = config.apiKey ?? process.env[facts.apiKeyEnv as string] ?? null
      if (key === null || key === '') {
        throw new Error(`MISSING_CREDENTIAL: no API key configured (env ${String(facts.apiKeyEnv) || 'unset'} / credentials.json)`)
      }
      return key
    },
    resolveUserId: () => ANONYMOUS_USER as never,
  })
}

class DeepSeekToolClient implements ToolLlmClient {
  constructor(
    private readonly adapter: DeepSeekAdapter,
    private readonly config: ResolvedChatConfig,
  ) {}

  /** StructuredCallClient seam: pass the raw dsh chunk stream through. */
  async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncGenerator<import('@deepseek-ai/dsh-llm').StreamChunk> {
    yield* this.adapter.stream(options)
  }

  async *request(
    system: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>> | null,
    signal?: AbortSignal,
  ): AsyncGenerator<{ kind: 'text'; delta: string } | { kind: 'toolCalls'; calls: ToolCall[] }> {
    const dshMessages = toDshMessages(messages)
    const toolSchemas = (tools ?? []).map(spec => {
      const fn = spec['function'] as { name: string; description: string; parameters: Record<string, unknown> }
      return { name: fn.name, description: fn.description, parameters: fn.parameters }
    })
    const callsByIndex = new Map<number, { id: string; name: string; argumentsDelta: string }>()

    for await (const chunk of this.adapter.stream({
      provider: this.config.providerId || 'studyclaw',
      model: this.config.model,
      system,
      messages: dshMessages,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
      temperature: this.config.temperature,
      ...(this.config.reasoningEffort === undefined || this.config.reasoningEffort === null
        ? {}
        : { reasoningEffort: ReasoningEffortId(this.config.reasoningEffort) }),
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta') {
        yield { kind: 'text', delta: chunk.text }
      } else if (chunk.type === 'reasoning-delta') {
        yield { kind: 'text', delta: chunk.text }
      } else if (chunk.type === 'tool-call-delta') {
        const existing = callsByIndex.get(chunk.index) ?? { id: '', name: '', argumentsDelta: '' }
        if (chunk.id !== undefined) existing.id = String(chunk.id)
        if (chunk.name !== undefined) existing.name = chunk.name
        existing.argumentsDelta += chunk.argumentsDelta
        callsByIndex.set(chunk.index, existing)
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(`${chunk.reason.failure.code}: ${chunk.reason.failure.message}`)
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
        return
      }
    }

    if (callsByIndex.size > 0) {
      const calls: ToolCall[] = [...callsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({
          id: call.id || `call_${Math.random().toString(36).slice(2)}`,
          name: call.name,
          arguments: safeParseArguments(call.argumentsDelta),
        }))
      yield { kind: 'toolCalls', calls }
    }
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return { _raw: raw }
  }
}

/** Translate OpenAI-shaped loop messages into the dsh Message vocabulary. */
function toDshMessages(messages: Array<Record<string, unknown>>): ReturnType<typeof createUserMessage>[] {
  return messages.map((message) => {
    const role = message['role']
    if (role === 'assistant') {
      const content: ContentBlock[] = []
      const text = message['content']
      if (typeof text === 'string' && text !== '') {
        content.push({ type: 'text', text })
      }
      const toolCalls = message['tool_calls']
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
          content.push({
            type: 'tool-call',
            id: CallId(call.id ?? ''),
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '{}',
          })
        }
      }
      return createAssistantMessage({
        content,
        source: { provider: 'studyclaw', model: 'studyclaw' },
      }) as unknown as ReturnType<typeof createUserMessage>
    }
    if (role === 'tool') {
      return createToolResultMessage({
        callId: CallId(String(message['tool_call_id'] ?? '')),
        content: [{ type: 'text', text: String(message['content'] ?? '') }],
        isError: false,
      }) as ReturnType<typeof createUserMessage>
    }
    return createUserMessage({
      content: [{ type: 'text', text: String(message['content'] ?? '') }],
      source: { kind: 'user' },
    }) as ReturnType<typeof createUserMessage>
  })
}
