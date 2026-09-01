/**
 * Local RPC entry guards shared by `studyclaw serve`'s node:http handler:
 * bounded body buffering (correct multi-byte UTF-8 across TCP chunks) and a
 * loopback-only Origin allowlist that closes the drive-by browser vector.
 */

/** Default cap for JSON bodies; uploads use Busboy limits instead. */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

export class PayloadTooLargeError extends Error {
  readonly code = 'payload-too-large'
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
  }
}

interface ChunkSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  destroy(): void
}

/**
 * Buffer the request as raw bytes and decode once. String concatenation of
 * implicit chunks (even with setEncoding, if dropped) or per-chunk toString
 * would corrupt a multi-byte UTF-8 char split across TCP segments — this was
 * the intermittent Chinese mojibake vector (P0-1), so no `setEncoding` path
 * may remain in front of JSON parsing.
 */
export async function readRequestBody(request: ChunkSource, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  return await new Promise<string>((resolve, reject) => {
    let tooLarge = false
    request.on('data', chunk => {
      if (tooLarge) return // 超限后续流全部丢弃：不再占内存，且连接保持可正常应答 413
      total += chunk.length
      if (total > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError(maxBytes))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', error => reject(error))
  })
}

/**
 * Browsers attach an Origin header to every cross-site request and it cannot
 * be forged by page JavaScript, so requiring a loopback origin blocks
 * malicious-webpage "drive-by" RPC while leaving curl/CLI clients (no Origin)
 * untouched. The dev frontend reaches us through the Next.js proxy, which
 * forwards the browser's localhost Origin verbatim.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1')
    )
  } catch {
    return false
  }
}
