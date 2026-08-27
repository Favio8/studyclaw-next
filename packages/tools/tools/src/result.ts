/**
 * Tool execution result vocabulary: the three-state result the chat loop
 * feeds back to the model, plus the registry's rejection/error types.
 * Ported from Python `agent_tools.py` `ToolResult`/`ToolError`/`ToolRejected`.
 * @module @studyclaw/tools/src/result
 */

import { MAX_TOOL_MESSAGE_CHARS } from './specs.ts'

/** Recoverable tool failure (bad args / policy); maps to `rejected`. */
export class ToolError extends Error {
  constructor(message: string, readonly code = 'TOOL_EXECUTION_FAILED') {
    super(message)
    this.name = 'ToolError'
  }
}

/** Caller-contract violation (bad path / malformed args); maps to `rejected`. */
export class ToolRejected extends ToolError {
  constructor(message: string, code = 'TOOL_INVALID_ARGS') {
    super(message, code)
    this.name = 'ToolRejected'
  }
}

export type ToolStatus = 'success' | 'degraded' | 'rejected'

/** 回灌模型时允许进入消息体的 data 键（白名单，防止把审计/元数据整包灌回）。 */
const MODEL_DATA_KEYS = new Set([
  'lines', 'content', 'text', 'matches', 'results', 'sources', 'items',
  'notes', 'output', 'stdout', 'stderr', 'diff', 'links', 'errors', 'cards',
])

function serializeModelData(data: Record<string, unknown>): string {
  const pieces: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (!MODEL_DATA_KEYS.has(key)) continue
    if (value === undefined || value === null) continue
    try {
      pieces.push(`${key}: ${JSON.stringify(value)}`)
    } catch {
      // 循环引用等不可序列化值直接跳过。
    }
  }
  return pieces.join('\n')
}

/**
 * One tool execution outcome: a user-facing summary, optional structured
 * data (kept out of the audit line), and an error code when degraded/rejected.
 */
export class ToolResult {
  constructor(
    readonly status: ToolStatus,
    readonly summary: string,
    readonly data: Record<string, unknown> = {},
    readonly error: string | null = null,
    readonly durationMs = 0,
    readonly renderIntent: string | null = null,
  ) {}

  static rejected(summary: string, code: string, renderIntent: string | null = null): ToolResult {
    return new ToolResult('rejected', summary, {}, code, 0, renderIntent)
  }

  static degraded(summary: string, code = 'TOOL_DEGRADED', renderIntent: string | null = null): ToolResult {
    return new ToolResult('degraded', summary, {}, code, 0, renderIntent)
  }

  /**
   * The `tool`-role message content fed back to the model.
   *
   * F-18：旧实现只回 summary（"我读了"），模型永远看不到读到的内容。
   * 现在按白名单键裁剪 data 序列化进消息体，并遵守全局字符预算——
   * 超预算截尾并显式标记，防 token 爆炸，也不把 audit 数据整个灌回去。
   */
  toToolMessage(maxChars: number = MAX_TOOL_MESSAGE_CHARS): string {
    const parts: string[] = [this.summary]
    if (this.status === 'success' || this.status === 'degraded') {
      const body = serializeModelData(this.data)
      if (body !== '') parts.push(body)
    }
    let message = parts.filter(part => part !== '').join('\n')
    if (message.length > maxChars) {
      message = `${message.slice(0, maxChars)}\n…[内容超预算已截断，原长 ${message.length} 字符]`
    }
    return message
  }

  /** The SSE `tool` event payload shape (same as the audit-line projection). */
  toEvent(name: string, publicArgs: Record<string, unknown>, callId?: string, parentCallId?: string | null): Record<string, unknown> {
    // Only state-management tools expose structured data to the durable
    // projection. Learning answers, note contents, and provider payloads stay
    // out of the event stream by default.
    const projectedData = name === 'plan' && Array.isArray(this.data['steps'])
      ? { steps: this.data['steps'].filter((item): item is string | Record<string, unknown> => typeof item === 'string' || (typeof item === 'object' && item !== null)).slice(0, 50) }
      : name === 'todo' && Array.isArray(this.data['items'])
        ? { items: this.data['items'].filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).slice(0, 100) }
        : undefined
    return {
      ...(callId === undefined ? {} : { callId }),
      ...(parentCallId === undefined ? {} : { parentCallId }),
      name,
      status: this.status,
      args: publicArgs,
      summary: this.summary,
      error: this.error,
      durationMs: this.durationMs,
      ...(this.renderIntent === null ? {} : { renderIntent: this.renderIntent }),
      ...(projectedData === undefined ? {} : { data: projectedData }),
    }
  }
}
