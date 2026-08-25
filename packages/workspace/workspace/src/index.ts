/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace
 * records, stable registry order, and rename-conflict enforcement over the
 * storage-domain data form. Ported from dsh-workspace `src/index.ts` without
 * the session-membership half (M2 reintroduces it with the session domain).
 * @module @studyclaw/workspace
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'
import { realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'
import { WorkspaceNameConflictError, WorkspaceOrderInvalidError } from './types.ts'

export { WorkspaceNameConflictError, WorkspaceOrderInvalidError } from './types.ts'
export type { Workspace } from './types.ts'
export { realpathNormalize } from './paths.ts'
export { workspaceDomainSpec, workspaceDomainState, workspaceRecord } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

/**
 * Durable workspace registry. Startup waits for `storageDomain`, opens the
 * workspace domain, completes any pending two-write mutation left by an
 * interrupted operation, validates stored state, and rebuilds the ordered
 * entity cache.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish a pending mutation when present, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof workspaceDomainSpec> = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      // A valid empty registry: nothing to bootstrap from yet (dsh bootstraps
      // workspace membership from session history here; sessions are M2).
      await this.setState({ ...this.state, initialized: true })
    }
    this.rebuildEntities()
  }

  /**
   * Create or reuse a workspace for an existing directory. The path is
   * canonicalized through `fs.realpath`; a nonexistent path rejects with the
   * original error and a non-directory rejects. Repeated calls for the same
   * canonical path return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in any path spelling.
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace, plus whether it was created now.
   */
  async create(path: string, title?: string): Promise<{ workspace: Workspace; created: boolean }> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(async () => {
      const existing = this.entityByPath(canonical)
      if (existing !== undefined) return { workspace: existing, created: false }
      return { workspace: await this.createCanonical(canonical, title), created: true }
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. This method
   * performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in any spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    return this.entityByPath(canonical)
  }

  /**
   * The host-level "current workspace" pointer: the last successfully opened
   * canonical path, or `''` when nothing was opened yet. Persisted in the
   * domain global so `serve` restores it across restarts.
   */
  get lastOpenedPath(): string {
    return this.requireState().lastOpenedPath
  }

  /**
   * Update the "current workspace" pointer durably.
   * @param path - Canonical path of the opened workspace.
   * @returns resolution after durability.
   */
  setLastOpenedPath(path: string): Promise<void> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.lastOpenedPath === path) return
      await this.setState({ ...state, lastOpenedPath: path })
    })
  }

  /**
   * Rename one workspace with conflict enforcement: the title is trimmed, a
   * no-change rename resolves without writing, and a title owned by another
   * workspace rejects with {@link WorkspaceNameConflictError}. dsh performs
   * this check at the RPC boundary; moving it into the registry lets the CLI
   * and the RPC share one enforcement point.
   * @param id - Workspace to rename.
   * @param title - New display title.
   * @returns resolution after durability.
   */
  rename(id: WorkspaceId, title: string): Promise<void> {
    return this.enqueueOperation(async () => {
      const entity = this.entities.get(id)
      if (entity === undefined) throw new WorkspaceOrderInvalidError(id)
      const trimmed = title.trim()
      if (trimmed === entity.title) return
      if (this.list().some(other => other.id !== id && other.title === trimmed)) {
        throw new WorkspaceNameConflictError(trimmed)
      }
      await entity.setTitle(trimmed)
    })
  }

  /**
   * Delete one workspace registration while retaining its directory. The
   * durable order is updated before the table deletion; a failed table write
   * restores the prior order and keeps the entity published. Unknown ids are
   * an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  private entityByPath(canonical: string): WorkspaceEntity | undefined {
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title?: string): Promise<WorkspaceEntity> {
    const workspaceName = title ?? basename(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        initialized: true,
        workspaceIds: [id, ...state.workspaceIds],
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write. Keep the durable marker
      // for startup recovery rather than reporting failure after the
      // requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from
   * its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    const { pendingMutation: _pending, ...cleared } = state
    await this.setState(cleared)
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Set<string>()
    for (const [, record] of table.entries()) {
      if (paths.has(record.path)) {
        throw new Error(`workspace domain is inconsistent: path '${record.path}' is claimed twice`)
      }
      paths.add(record.path)
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await this.global!.set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

export default WorkspaceRegistry
