/**
 * One opened JSON unit. The in-memory state is authoritative; every write
 * primitive runs mutation, atomic publish and any rollback in one serialized
 * window. Concurrent calls are admitted in invocation order, so a failed
 * earlier write cannot overwrite the memory or medium of a later success.
 * @module @deepseek-ai/dsh-storage-json/src/unit
 */

import { readFile } from 'node:fs/promises'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * Reject values `JSON.stringify` would silently mangle: `NaN`/`Infinity`
 * become `null`, `undefined`/function fields are dropped, `Date`/`Map`/`Set`
 * change shape. Such a write would resolve "durable" yet only fail the
 * domain's schema validation on reopen — bricking the unit with no recovery
 * path. Failing at the write boundary keeps memory and medium consistent.
 */
function assertJsonSafe(unit: string, value: unknown, path = 'value'): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        throw new StorageError('malformed-medium', `unit '${unit}': ${path} is not JSON-safe (NaN/Infinity serializes to null)`)
      }
      return
    case 'object':
      if (Array.isArray(value)) {
        value.forEach((entry, index) => assertJsonSafe(unit, entry, `${path}[${index}]`))
        return
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        const label = (value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain object'
        throw new StorageError('malformed-medium', `unit '${unit}': ${path} is not JSON-safe (${label} does not round-trip)`)
      }
      // Object.entries mirrors JSON.stringify exactly: own enumerable keys only.
      for (const [key, entry] of Object.entries(value)) assertJsonSafe(unit, entry, `${path}.${key}`)
      return
    default:
      throw new StorageError('malformed-medium', `unit '${unit}': ${path} has JSON-unrepresentable type '${typeof value}'`)
  }
}

/**
 * Open (load or lazily create) one unit backed by `path`.
 * @param descriptor - Static identity and shape of the unit.
 * @param path - Absolute unit file path under the backend root.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export async function openJsonUnit(
  descriptor: KvUnitDescriptor,
  path: string,
  onClose: () => void,
): Promise<KvUnit> {
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new JsonKvUnit(descriptor, path, state, onClose)
}

class JsonKvUnit implements KvUnit {
  private closed = false
  /** In-flight publishes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Serialization chain for whole-file publishes (see publish()). */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertJsonSafe(this.descriptor.name, value)
    const records = this.records(table)
    await this.publish(async () => {
      const hadKey = records.has(key)
      const previous = records.get(key)
      records.set(key, value)
      try { await writeAtomic(this.path, serialize(this.descriptor.name, this.state)) } catch (error) {
        if (hadKey) records.set(key, previous)
        else records.delete(key)
        throw error
      }
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    await this.publish(async () => {
      if (!records.has(key)) return
      const previous = records.get(key)
      records.delete(key)
      try { await writeAtomic(this.path, serialize(this.descriptor.name, this.state)) } catch (error) {
        records.set(key, previous)
        throw error
      }
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    assertJsonSafe(this.descriptor.name, value, 'global')
    await this.publish(async () => {
      const previous = this.state.global
      this.state.global = value
      try { await writeAtomic(this.path, serialize(this.descriptor.name, this.state)) } catch (error) {
        this.state.global = previous
        throw error
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private publish(mutateAndPersist: () => Promise<void>): Promise<void> {
    // Serialize the entire mutation/publish/rollback window. Serializing only
    // rename lets a failed earlier mutation roll back a later successful one.
    const write = this.writeChain
      .catch(() => undefined)
      .then(mutateAndPersist)
    this.writeChain = write
    this.inFlight.add(write)
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}
