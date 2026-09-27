/**
 * Local RPC entry guards shared by `studyclaw serve`'s node:http handler:
 * bounded body buffering (correct multi-byte UTF-8 across TCP chunks) and a
 * loopback-only Origin allowlist that closes the drive-by browser vector.
 */

/** Default cap for JSON bodies; uploads use Busboy limits instead. */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

/** NEW-002：请求体读取超时（Slowloris 防护）。正常 2.5MB 内网请求秒级完成，
 *  30s 只会拦住"永远不发完/不发"的恶意慢速连接。 */
export const REQUEST_BODY_TIMEOUT_MS = 30_000

export class PayloadTooLargeError extends Error {
  readonly code = 'payload-too-large'
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
  }
}

export class RequestBodyTimeoutError extends Error {
  readonly code = 'request-timeout'
  constructor(timeoutMs: number) {
    super(`request body not completed within ${timeoutMs}ms`)
  }
}

interface ChunkSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  destroy(): void
}

/**
 * Buffer the request as raw bytes and decode once. String concatenation of
 * implicit chunks (even with setEncoding, if dropped) or per-chunk toString
 * would corrupt a multi-byte UTF-8 char split across TCP segments — this was
 * the intermittent Chinese mojibake vector (P0-1), so no `setEncoding` path
 * may remain in front of JSON parsing.
 *
 * NEW-002：全程有超时与 close 保护——只发一半请求体、或建立连接后不发数据
 * 的客户端不能无限占用连接与缓冲；超时/提前断开即销毁连接并拒绝。
 */
export async function readRequestBody(
  request: ChunkSource,
  maxBytes: number = MAX_JSON_BODY_BYTES,
  timeoutMs: number = REQUEST_BODY_TIMEOUT_MS,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  return await new Promise<string>((resolve, reject) => {
    let tooLarge = false
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      settle(() => reject(new RequestBodyTimeoutError(timeoutMs)))
      request.destroy()
    }, timeoutMs)
    request.on('data', chunk => {
      if (tooLarge || settled) return // 超限后续流全部丢弃：不再占内存，且连接保持可正常应答 413
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
        settle(() => reject(new PayloadTooLargeError(maxBytes)))
        return
      }
      settle(() => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.on('error', error => settle(() => reject(error)))
    // 'close' 在正常 'end' 之后也会触发；settled 标记保证只结算一次。
    request.on('close', () => {
      if (settled) return
      settle(() => reject(new Error('request connection closed before body completed')))
      request.destroy()
    })
  })
}

/**
 * BUG-005：错误消息出日志/出 API 前净化高置信凭据特征。上游异常（fetch 失败、
 * 厂商 4xx 回显）可能内嵌 apiKey/token（URL 查询参数、Authorization 头、
 * sk-/AIza/gsk_ 前缀密钥、URL 用户信息段），落盘到 host 日志或返回给调用方
 * 即成泄露面。只净化凭据模式、不动文件路径等诊断信息——本地单用户应用，
 * 路径本身就是可行动的排障线索。
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    // URL 查询参数里的 key/token/secret/password/auth
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|secret|password|auth|key)=)[^&\s'"]+/gi, '$1***')
    // Authorization: Bearer <token>
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    // 常见厂商密钥前缀
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/\bgsk_[A-Za-z0-9]{10,}/g, 'gsk_***')
    // URL 用户信息段 http://user:pass@host
    .replace(/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1***:***@')
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
