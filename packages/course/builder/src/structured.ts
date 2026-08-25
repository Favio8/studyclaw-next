/**
 * Structured LLM output helper: zod schema → JSON Schema tool, force via a
 * single `_emit` tool; when the model answers with plain text instead, the
 * JSON is extracted from the text (markdown fences included) — the
 * instructor-equivalent of Python's JSON_SCHEMA → JSON → MD_JSON fallback
 * chain, implemented over the dsh StreamChunk vocabulary.
 * @module @studyclaw/course-builder/src/structured
 */

import { z } from 'zod'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'

export interface StructuredCallClient {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

const EMIT_TOOL = '_emit_structured'

/** Extract a JSON object from model text (fenced or bare, Python parity). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g.exec(text)
  const candidates = fenced !== null ? [fenced[1]!] : [text]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    for (let i = start; i < candidate.length; i += 1) {
      if (candidate[i] === '{') depth += 1
      else if (candidate[i] === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as unknown
          } catch {
            break
          }
        }
      }
    }
  }
  throw new Error('响应中未找到合法 JSON')
}

/**
 * One structured call: asks the model for the schema via a single `_emit`
 * tool; on a text-only reply, falls back to JSON extraction; on parse
 * failure the error is injected and the call retried up to `maxRetries`.
 * @returns the validated output.
 */
export async function structuredCall<S extends z.ZodType>(
  client: StructuredCallClient,
  schema: S,
  options: Omit<GenerateOptions, 'tools'> & { tools?: ToolSchema[] },
  maxRetries = 3,
): Promise<z.infer<S>> {
  const toolSchema: ToolSchema = {
    name: EMIT_TOOL,
    description: '输出符合给定 Schema 的 JSON 数据（只输出一个 JSON 对象）',
    parameters: z.toJSONSchema(schema, { target: 'json-schema' }) as Record<string, unknown>,
  }
  const tools = [...(options.tools ?? []), toolSchema]
  let feedback = ''
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const system = `${options.system ?? ''}\n\n只允许调用 ${EMIT_TOOL} 工具输出结果，不要输出解释文字。${feedback !== '' ? `\n\n上一次失败原因：${feedback}` : ''}`
    try {
      const raw = await callOnce(client, { ...options, system, tools })
      return schema.parse(raw) as z.infer<S>
    } catch (error) {
      feedback = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`结构化输出重试 ${maxRetries} 次仍失败：${feedback}`)
}

async function callOnce(client: StructuredCallClient, options: GenerateOptions): Promise<unknown> {
  const calls = new Map<number, { id: string; name: string; argumentsDelta: string }>()
  const textParts: string[] = []
  for await (const chunk of client.stream(options)) {
    if (chunk.type === 'text-delta') textParts.push(chunk.text)
    else if (chunk.type === 'reasoning-delta') textParts.push(chunk.text)
    else if (chunk.type === 'tool-call-delta') {
      const existing = calls.get(chunk.index) ?? { id: '', name: '', argumentsDelta: '' }
      if (chunk.id !== undefined) existing.id = String(chunk.id)
      if (chunk.name !== undefined) existing.name = chunk.name
      existing.argumentsDelta += chunk.argumentsDelta
      calls.set(chunk.index, existing)
    }
  }
  for (const call of [...calls.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (call.name === EMIT_TOOL) {
      return extractJsonObject(call.argumentsDelta)
    }
  }
  // Text-only reply: MD_JSON fallback.
  return extractJsonObject(textParts.join(''))
}

export { CallId }
