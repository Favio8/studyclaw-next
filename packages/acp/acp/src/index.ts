/**
 * Transport-neutral ACP/JSON-RPC contracts.
 *
 * The Host owns Agent composition and persistence. This package owns only
 * request validation, method aliases, stable error codes, and update framing
 * so Web, CLI and stdio adapters cannot drift apart.
 * @module @studyclaw/acp
 */

export const ACP_PROTOCOL_VERSION = 1 as const

export interface AcpRequest {
  readonly jsonrpc?: '2.0'
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

export interface AcpResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export interface AcpNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params: Record<string, unknown>
}

export interface AcpUpdate {
  readonly sessionId: string | null
  readonly kind: string
  readonly [key: string]: unknown
}

export interface AcpHost {
  initialize?(): Promise<Record<string, unknown>> | Record<string, unknown>
  createSession?(params: Record<string, unknown>): Promise<unknown>
  resumeSession?(params: Record<string, unknown>): Promise<unknown>
  forkSession?(params: Record<string, unknown>): Promise<unknown>
  replaySession?(params: Record<string, unknown>): Promise<unknown>
  prompt?(params: Record<string, unknown>, emit?: (update: AcpUpdate) => void, signal?: AbortSignal): Promise<unknown>
  cancel?(params: Record<string, unknown>): Promise<unknown>
  answer?(params: Record<string, unknown>): Promise<unknown>
  listAgents?(params: Record<string, unknown>): Promise<unknown>
  statusAgent?(params: Record<string, unknown>): Promise<unknown>
  whenIdle?(params: Record<string, unknown>): Promise<unknown>
  maintenance?(params: Record<string, unknown>): Promise<unknown>
  maintenanceJobs?(params: Record<string, unknown>): Promise<unknown>
  disposeAgent?(params: Record<string, unknown>): Promise<unknown>
  projection?(params: Record<string, unknown>): Promise<unknown>
  listModels?(params: Record<string, unknown>): Promise<unknown>
  selectModel?(params: Record<string, unknown>): Promise<unknown>
  listApprovals?(params: Record<string, unknown>): Promise<unknown>
  resolveApproval?(params: Record<string, unknown>): Promise<unknown>
  getPlan?(params: Record<string, unknown>): Promise<unknown>
  updatePlan?(params: Record<string, unknown>): Promise<unknown>
  getTodo?(params: Record<string, unknown>): Promise<unknown>
  updateTodo?(params: Record<string, unknown>): Promise<unknown>
}

export const ACP_METHODS = {
  initialize: 'initialize',
  createSession: 'session.create',
  resumeSession: 'session.resume',
  forkSession: 'session.fork',
  replaySession: 'session.replay',
  prompt: 'session.prompt',
  cancel: 'session.cancel',
  answer: 'agents.answer',
  listAgents: 'agents.list',
  statusAgent: 'agents.status',
  whenIdle: 'agents.whenIdle',
  maintenance: 'agents.maintenance',
  maintenanceJobs: 'agents.maintenanceJobs',
  disposeAgent: 'agents.dispose',
  projection: 'agents.projection',
  listModels: 'model.list',
  selectModel: 'model.select',
  listApprovals: 'approval.list',
  resolveApproval: 'approval.resolve',
  getPlan: 'plan.get',
  updatePlan: 'plan.update',
  getTodo: 'todo.get',
  updateTodo: 'todo.update',
} as const

const methodAliases: Record<string, keyof AcpHost | 'initialize'> = {
  initialize: 'initialize',
  'protocol.initialize': 'initialize',
  'session.new': 'createSession',
  'session.create': 'createSession',
  'session.load': 'resumeSession',
  'session.resume': 'resumeSession',
  'session.fork': 'forkSession',
  'session.replay': 'replaySession',
  prompt: 'prompt',
  'session.prompt': 'prompt',
  'session.send': 'prompt',
  'session.cancel': 'cancel',
  'session.events': 'replaySession',
  'sessions.events': 'replaySession',
  'agents.create': 'createSession',
  'agents.resume': 'resumeSession',
  'agents.list': 'listAgents',
  'agents.status': 'statusAgent',
  'agents.cancel': 'cancel',
  'agents.answer': 'answer',
  'agents.whenIdle': 'whenIdle',
  'agents.maintenance': 'maintenance',
  'agents.maintenanceJobs': 'maintenanceJobs',
  'agents.dispose': 'disposeAgent',
  'agents.projection': 'projection',
  'agent.create': 'createSession',
  'agent.resume': 'resumeSession',
  'agent.list': 'listAgents',
  'agent.status': 'statusAgent',
  'agent.cancel': 'cancel',
  'agent.answer': 'answer',
  'agent.whenIdle': 'whenIdle',
  'agent.maintenance': 'maintenance',
  'agent.maintenanceJobs': 'maintenanceJobs',
  'agent.dispose': 'disposeAgent',
  'agent.projection': 'projection',
  'model.list': 'listModels',
  'model.select': 'selectModel',
  'approval.list': 'listApprovals',
  'approval.resolve': 'resolveApproval',
  'plan.get': 'getPlan',
  'plan.update': 'updatePlan',
  'todo.get': 'getTodo',
  'todo.update': 'updateTodo',
}

export function parseAcpRequest(value: unknown): AcpRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AcpProtocolError(-32600, 'Invalid Request')
  const request = value as Record<string, unknown>
  if (request['jsonrpc'] !== undefined && request['jsonrpc'] !== '2.0') throw new AcpProtocolError(-32600, 'jsonrpc must be 2.0')
  if (typeof request['method'] !== 'string' || request['method'].trim() === '') throw new AcpProtocolError(-32600, 'method is required')
  const id = request['id']
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') throw new AcpProtocolError(-32600, 'id must be a string, number, or null')
  return { jsonrpc: '2.0', id: id === undefined ? null : id as string | number | null, method: request['method'], params: request['params'] }
}

export class AcpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}

function paramsOf(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AcpProtocolError(-32602, 'params must be an object')
  return value as Record<string, unknown>
}

/** Small JSON-RPC router used by HTTP, CLI stdio, and ACP test transports. */
export class AcpRouter {
  constructor(readonly host: AcpHost) {}

  async handle(value: unknown, options: { emit?: (notification: AcpNotification) => void; signal?: AbortSignal } = {}): Promise<AcpResponse> {
    let request: AcpRequest
    try { request = parseAcpRequest(value) } catch (error) {
      return this.error(null, error instanceof AcpProtocolError ? error : new AcpProtocolError(-32603, String(error)))
    }
    const id = request.id ?? null
    try {
      if (request.method === 'initialize' || request.method === 'protocol.initialize') {
        const result = await this.host.initialize?.() ?? {
          protocolVersion: ACP_PROTOCOL_VERSION,
          serverInfo: { name: 'studyclaw', version: '0.1.0' },
          capabilities: { sessions: true, prompt: true, replay: true, cancellation: true, approvals: true, models: true },
        }
        return { jsonrpc: '2.0', id, result }
      }
      const method = methodAliases[request.method!]
      if (method === undefined || this.host[method] === undefined) return this.error(id, new AcpProtocolError(-32601, `Method not found: ${request.method}`))
      const params = paramsOf(request.params)
      let result: unknown
      if (method === 'prompt') {
        const emit = options.emit
        result = await this.host.prompt!(params, emit === undefined ? undefined : update => emit({ jsonrpc: '2.0', method: 'session/update', params: update }), options.signal)
      } else {
        const handler = this.host[method] as ((params: Record<string, unknown>) => Promise<unknown>)
        result = await handler.call(this.host, params)
      }
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      return this.error(id, error instanceof AcpProtocolError ? error : new AcpProtocolError(-32603, error instanceof Error ? error.message : String(error)))
    }
  }

  private error(id: string | number | null, error: AcpProtocolError): AcpResponse {
    return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
  }
}
