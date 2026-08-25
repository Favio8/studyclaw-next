/**
 * Public type vocabulary of the workspace registry: the `WorkspaceId` brand,
 * the `Workspace` consumer interface, and the business error types the RPC
 * layer maps to stable codes. Types and errors only — no other runtime code.
 * Ported from dsh-workspace `src/types.ts`; session accounting is out of M1
 * scope and therefore absent.
 * @module @studyclaw/workspace/src/types
 */

/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }

/**
 * One workspace: a stable id over an existing directory and a display title.
 * Duplicate titles across different paths are allowed; only rename checks
 * for conflicts.
 */
export interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Replace the display title durably. Any string; the conflict check lives
   * one level up in the registry's `rename` (dsh performs it at the RPC
   * boundary — here both the CLI and the RPC share one enforcement point).
   * @param title - New title.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}

/** A reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}

/** A rename asked for a title another workspace already owns. */
export class WorkspaceNameConflictError extends Error {
  constructor(readonly workspaceName: string) {
    super(`another workspace is already named '${workspaceName}'`)
    this.name = 'WorkspaceNameConflictError'
  }
}
