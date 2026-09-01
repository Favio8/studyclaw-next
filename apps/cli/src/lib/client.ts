/**
 * StudyClaw CLI HTTP client: unary RPC envelope (`POST /api/<method>`, body
 * `{ payload }`) and SSE consumption for the three stream endpoints
 * (chat/stream, eval.submit, agents/answer/stream). The fetch implementation
 * and base URL are injectable for tests; production uses `fetch` + env.
 * FL-30/35：默认从 `<hostHome>/host.json` 自动发现端口与 token 并附加
 * `Authorization: Bearer` 头。Ported from apps/web/src/lib/api.ts frame parsing.
 * @module @studyclaw/cli/lib/client
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClientDeps {
  baseUrl: string
  /** FL-30：宿主签发的访问 token（host.json）；显式传入优先于自动发现。 */
  token?: string
  fetch?: typeof fetch
}

/** Injectable unary-RPC function shape (hostRpc satisfies it). */
export type RpcFn = <T>(method: string, payload: unknown) => Promise<T>

export class CliError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'CliError'
    this.code = code
  }
}

/** FL-30/35：从 `<hostHome>/host.json` 发现宿主（实际端口 + token）。
 * 读取失败（尚未 serve）返回 null——回退到默认端口 8080。 */
interface HostDiscovery {
  baseUrl: string
  token: string | null
}

let discoveryCache: { readAt: number; value: HostDiscovery | null } | null = null

function discoverHost(): HostDiscovery | null {
  // 进程内短缓存：同一 CLI 进程反复 RPC 不重读盘；5s 过期容忍宿主重启。
  if (discoveryCache !== null && Date.now() - discoveryCache.readAt < 5_000) return discoveryCache.value
  let value: HostDiscovery | null = null
  try {
    const home = process.env.STUDYCLAW_HOME ?? join(homedir(), '.studyclaw')
    const parsed = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8')) as { port?: number; token?: string | null }
    if (typeof parsed.port === 'number' && Number.isFinite(parsed.port)) {
      value = {
        baseUrl: `http://127.0.0.1:${parsed.port}`,
        token: typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : null,
      }
    }
  } catch {
    value = null
  }
  discoveryCache = { readAt: Date.now(), value }
  return value
}

export function defaultClientDeps(): ClientDeps {
  // FL-35：host.json 记录的实际端口优先（--port 0 随机端口也能发现）；
  // 显式 STUDYCLAW_HOST_URL 仍最高优先（此时仅复用其 token）。
  if (process.env.STUDYCLAW_HOST_URL === undefined) {
    const discovered = discoverHost()
    if (discovered !== null) {
      if (discovered.token === null) return { baseUrl: discovered.baseUrl }
      return { baseUrl: discovered.baseUrl, token: discovered.token }
    }
  }
  const deps: ClientDeps = { baseUrl: (process.env.STUDYCLAW_HOST_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8080'}`).replace(/\/$/, '') }
  const discovered = discoverHost()
  if (discovered !== null && discovered.token !== null) deps.token = discovered.token
  return deps
}

/** 统一附加 token 头（FL-30）。 */
export function authHeaders(deps: ClientDeps): Record<string, string> {
  return deps.token === undefined || deps.token === '' ? {} : { authorization: `Bearer ${deps.token}` }
}

async function doFetch(deps: ClientDeps, input: string, init: RequestInit): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(input, init)
  } catch {
    throw new CliError('HOST_UNREACHABLE', `无法连接 host（${deps.baseUrl}），请先运行 studyclaw serve`)
  }
}

export interface RpcEnvelope<T> {
  ok?: boolean
  result?: T
  error?: { code?: string; message?: string }
}

/** Unary RPC: 信封 `{ok:true,result} | {ok:false,error}`。 */
export async function hostRpc<T>(method: string, payload: unknown, deps: ClientDeps = defaultClientDeps()): Promise<T> {
  const response = await doFetch(deps, `${deps.baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(deps) },
    body: JSON.stringify({ payload }),
  })
  const envelope = await response.json().catch(() => null) as RpcEnvelope<T> | null
  if (!response.ok || envelope?.ok !== true) {
    throw new CliError(envelope?.error?.code ?? `HTTP_${response.status}`, envelope?.error?.message ?? response.statusText)
  }
  return envelope.result as T
}

export interface SseFrame {
  event: string
  data: unknown
}

/** SSE 帧流解析：`event:` / `data:` 行 → 结构化事件（与 web api.ts 一致）。 */
export async function* streamSse(
  path: string,
  body: unknown,
  deps: ClientDeps = defaultClientDeps(),
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders(deps) },
    body: JSON.stringify(body),
  }
  if (signal !== undefined) init.signal = signal
  const response = await doFetch(deps, `${deps.baseUrl}${path}`, init)
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    let code = 'INTERNAL_ERROR'
    let message = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
      code = parsed?.error?.code ?? code
      message = parsed?.error?.message ?? message
    } catch {
      // 非 JSON 错误体
    }
    throw new CliError(code, message)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseSseBlock(block)
      if (parsed !== null) yield parsed
      boundary = buffer.indexOf('\n\n')
    }
  }
  const tail = parseSseBlock(buffer)
  if (tail !== null) yield tail
}

function parseSseBlock(block: string): SseFrame | null {
  let event = ''
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
  }
  if (event === '') return null
  const data = dataLines.length > 0 ? JSON.parse(dataLines.join('')) as unknown : {}
  return { event, data }
}

/** `POST /api/chat/stream`。 */
export function streamChat(payload: Record<string, unknown>, deps?: ClientDeps, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  return streamSse('/api/chat/stream', payload, deps, signal)
}

/** `POST /api/eval.submit`：scan / rubric×N / result / sm2 / done 六帧。 */
export function streamEval(payload: Record<string, unknown>, deps?: ClientDeps, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  return streamSse('/api/eval.submit', payload, deps, signal)
}

/** `POST /api/agents/answer/stream`：ask 挂起后恢复 Agent turn。 */
export function streamAgentAnswer(payload: Record<string, unknown>, deps?: ClientDeps, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  return streamSse('/api/agents/answer/stream', payload, deps, signal)
}
