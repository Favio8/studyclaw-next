/**
 * Streaming splitters: `<think>` reasoning blocks and the hidden
 * `[STUDYCLAW_SYNC]` block are diverted out of the user-visible text stream
 * (tail-reserve buffer prevents marker leakage across chunks). Ported
 * verbatim from Python `session.py` `stream_split`/`_ToolStreamSplitter`.
 * @module @studyclaw/session/src/splitter
 */

import { syncBlock, type SyncBlock } from './models.ts'
import { SessionError } from './store.ts'

export const SYNC_MARKER = '[STUDYCLAW_SYNC]'
export const SYNC_KEY = '_studyclaw_sync'
export const TAIL_RESERVE = 48

export type StreamEvent = { kind: 'text' | 'think' | 'sync'; delta: string }

/** Extract the hidden sync block: returns (remaining visible text, payload). */
export function extractSync(text: string): [string, SyncBlock | null] {
  const index = text.indexOf(SYNC_MARKER)
  if (index < 0) return [text, null]
  const visible = (text.slice(0, index) + text.slice(endOfSyncJson(text, index + SYNC_MARKER.length))).trim()
  const rawJson = syncJsonText(text, index + SYNC_MARKER.length)
  if (rawJson === null) return [visible, null]
  let data: unknown
  try {
    data = JSON.parse(rawJson)
  } catch {
    return [visible, null]
  }
  if (typeof data !== 'object' || data === null) return [visible, null]
  const record = data as Record<string, unknown>
  // 正规包裹形态：{"_studyclaw_sync": {...}}（prompts.ts 教的标准格式）。
  if (SYNC_KEY in record) {
    try {
      return [visible, syncBlock.parse(record[SYNC_KEY])]
    } catch {
      // Schema violation: contract first (Python raises SessionError).
      throw new SessionError('[STUDYCLAW_SYNC] 载荷 Schema 非法')
    }
  }
  // 兼容形态：历史上/部分模型会按裸对象直接给字段。带任一已知字段的才按
  // 裸载荷校验——两不匹配的匿名对象依旧静默忽略，保持既有容错语义。
  const looksBare = Array.isArray(record['concept_updates'])
    || Array.isArray(record['memory_hints'])
    || typeof record['changelog'] === 'string'
  if (looksBare) {
    try {
      return [visible, syncBlock.parse(record)]
    } catch {
      throw new SessionError('[STUDYCLAW_SYNC] 载荷 Schema 非法')
    }
  }
  return [visible, null]
}

function syncJsonText(text: string, start: number): string | null {
  const open = text.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

function endOfSyncJson(text: string, start: number): number {
  const open = text.indexOf('{', start)
  if (open < 0) return text.length
  const block = syncJsonText(text, start)
  return block === null ? text.length : open + block.length
}

export interface ParsedTurn {
  readonly visible: string
  readonly thinks: readonly string[]
  readonly syncRaw: SyncBlock | null
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/g

/** One-shot full-text parse (tests + fallback). */
export function parseFull(text: string): ParsedTurn {
  const [visibleThinkless, syncRaw] = extractSync(text)
  const thinks: string[] = []
  const visible = visibleThinkless.replace(THINK_RE, (_match, body: string) => {
    thinks.push(body.trim())
    return ''
  }).trim()
  return { visible, thinks, syncRaw }
}

/**
 * Chunk-split a text stream into `("text"|"think", delta)` events. The tail
 * reserve buffers `_TAIL_RESERVE` chars so `<think>` boundaries and the sync
 * marker never leak into the visible stream; sync content is fully swallowed
 * (one `("sync","")` event marks the interception).
 */
export function* streamSplit(chunks: Iterable<string>): Generator<StreamEvent> {
  let buffer = ''
  let thinkOpen = false
  let syncSeen = false

  function* drain(final: boolean): Generator<StreamEvent> {
    if (syncSeen) {
      buffer = ''
      return
    }
    let hold = final ? 0 : Math.min(buffer.length, TAIL_RESERVE)
    while (true) {
      if (!syncSeen) {
        const markerIdx = buffer.indexOf(SYNC_MARKER)
        if (markerIdx >= 0) {
          buffer = buffer.slice(0, markerIdx).trimEnd()
          syncSeen = true
          hold = 0
          yield { kind: 'sync', delta: '' }
          if (buffer === '') return
          continue
        }
        hold = final ? 0 : Math.min(buffer.length, TAIL_RESERVE)
      }
      const flushLen = syncSeen ? buffer.length : buffer.length - hold
      if (!thinkOpen) {
        const openIdx = buffer.indexOf('<think>')
        if (openIdx >= 0) {
          if (openIdx > 0 && openIdx <= flushLen) yield { kind: 'text', delta: buffer.slice(0, openIdx) }
          buffer = buffer.slice(openIdx + '<think>'.length)
          thinkOpen = true
          continue
        }
        if (flushLen > 0) {
          yield { kind: 'text', delta: buffer.slice(0, flushLen) }
          buffer = buffer.slice(flushLen)
        }
        return
      }
      const closeIdx = buffer.indexOf('</think>')
      if (closeIdx >= 0) {
        if (closeIdx > 0) yield { kind: 'think', delta: buffer.slice(0, closeIdx) }
        buffer = buffer.slice(closeIdx + '</think>'.length)
        thinkOpen = false
        continue
      }
      const safe = flushLen > 0 ? flushLen : buffer.length - hold
      if (safe > 0) {
        yield { kind: 'think', delta: buffer.slice(0, safe) }
        buffer = buffer.slice(safe)
      }
      return
    }
  }

  for (const chunk of chunks) {
    buffer += chunk
    yield* drain(false)
  }
  if (buffer.trim() !== '') yield* drain(true)
  if (buffer.trim() !== '' && thinkOpen && !syncSeen) yield { kind: 'think', delta: buffer }
}

/**
 * Event-driven splitter for the tool loop: content arrives in deltas across
 * multiple LLM requests; `feed` returns what the current chunk can emit and
 * `flush` drains the residue at round end (markers never survive a round).
 */
export class ToolStreamSplitter {
  private buffer = ''
  private thinkOpen = false
  private syncSeen = false

  feed(chunk: string): StreamEvent[] {
    if (chunk !== '') this.buffer += chunk
    return this.drain(false)
  }

  flush(): StreamEvent[] {
    const out: StreamEvent[] = []
    if (this.buffer.trim() !== '') out.push(...this.drain(true))
    if (this.buffer.trim() !== '' && this.thinkOpen && !this.syncSeen) {
      out.push({ kind: 'think', delta: this.buffer })
    }
    this.buffer = ''
    this.thinkOpen = false
    this.syncSeen = false
    return out
  }

  private drain(final: boolean): StreamEvent[] {
    const out: StreamEvent[] = []
    const emit = (kind: 'text' | 'think', delta: string): void => { out.push({ kind, delta }) }
    if (this.syncSeen) {
      this.buffer = ''
      return out
    }
    while (true) {
      if (!this.syncSeen) {
        const markerIdx = this.buffer.indexOf(SYNC_MARKER)
        if (markerIdx >= 0) {
          this.buffer = this.buffer.slice(0, markerIdx).trimEnd()
          this.syncSeen = true
          out.push({ kind: 'sync', delta: '' })
          if (this.buffer === '') return out
          continue
        }
      }
      const hold = final ? 0 : Math.min(this.buffer.length, TAIL_RESERVE)
      const flushLen = this.syncSeen ? this.buffer.length : this.buffer.length - hold
      if (!this.thinkOpen) {
        const openIdx = this.buffer.indexOf('<think>')
        if (openIdx >= 0) {
          if (openIdx > 0 && openIdx <= flushLen) emit('text', this.buffer.slice(0, openIdx))
          this.buffer = this.buffer.slice(openIdx + '<think>'.length)
          this.thinkOpen = true
          continue
        }
        if (flushLen > 0) {
          emit('text', this.buffer.slice(0, flushLen))
          this.buffer = this.buffer.slice(flushLen)
        }
        return out
      }
      const closeIdx = this.buffer.indexOf('</think>')
      if (closeIdx >= 0) {
        if (closeIdx > 0) emit('think', this.buffer.slice(0, closeIdx))
        this.buffer = this.buffer.slice(closeIdx + '</think>'.length)
        this.thinkOpen = false
        continue
      }
      const safe = flushLen > 0 ? flushLen : this.buffer.length - hold
      if (safe > 0) {
        emit('think', this.buffer.slice(0, safe))
        this.buffer = this.buffer.slice(safe)
      }
      return out
    }
  }
}
