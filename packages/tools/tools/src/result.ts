/**
 * Tool execution result vocabulary: the three-state result the chat loop
 * feeds back to the model, plus the registry's rejection/error types.
 * Ported from Python `agent_tools.py` `ToolResult`/`ToolError`/`ToolRejected`.
 * @module @studyclaw/tools/src/result
 */

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

  /** The `tool`-role message content fed back to the model (no data body). */
  toToolMessage(): string {
    return this.summary
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
