/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema is the durable-boundary validator today
 * and the direct source of the RPC wire projection. Ported from dsh-workspace
 * `src/spec.ts` without the session-account fields (M2 adds them back).
 * @module @studyclaw/workspace/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from a never-written medium; `workspaceIds` is the authoritative display
 * order; `lastOpenedPath` is the host-level "current workspace" pointer the
 * serve command restores at startup (empty string = none yet).
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  workspaceIds: z.array(workspaceId),
  lastOpenedPath: z.string().default(''),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the order singleton. The registry opens this
 * through `ctx.storageDomain`; the spec object is the single source of the
 * domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 1,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], lastOpenedPath: '' },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
