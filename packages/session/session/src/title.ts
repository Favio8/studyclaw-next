/**
 * Title text normalization and UTF-8-safe truncation.
 *
 * Vendored from deepseek-harness (dsh) `packages/session/session-title/src/normalize.ts`
 * (MIT License, Copyright (c) DeepSeek AI). Adapted for StudyClaw: the regexes are
 * built at runtime from code points so the source stays free of raw control
 * characters, with StudyClaw's fallback title policy layered on top.
 * @module @studyclaw/session/src/title
 */

function cp(code: number): string {
  return String.fromCodePoint(code)
}

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = new RegExp(
  `(?:${cp(0x1b)}\\]|${cp(0x9d)})(?:(?!${cp(0x07)}|${cp(0x1b)}\\\\)[\\s\\S])*(?:${cp(0x07)}|${cp(0x1b)}\\\\|$)`,
  'gu',
)
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = new RegExp(`(?:${cp(0x1b)}\\[|${cp(0x9b)})[0-?]*[ -/]*[@-~]`, 'gu')
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = new RegExp(`${cp(0x1b)}[@-_]`, 'gu')
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = new RegExp(
  `[${cp(0x00)}-${cp(0x08)}${cp(0x0b)}${cp(0x0c)}${cp(0x0e)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}]`,
  'gu',
)
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = new RegExp(
  `[${cp(0x200b)}${cp(0x200e)}${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2064)}${cp(0x2066)}-${cp(0x206f)}${cp(0xfeff)}]`,
  'gu',
)

/** Reject an invalid public text limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Remove controls and produce one trimmed, whitespace-normalized line. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - normalized title text.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Normalize one accepted session title and enforce its UTF-8 byte budget.
 * @param input - untrusted title text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe one-line title, possibly empty after sanitization.
 */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/**
 * Derive the deterministic first-prompt fallback.
 * @param input - text from the first eligible human message.
 * @param maxWords - positive whitespace-delimited word cap.
 * @param maxBytes - positive UTF-8 byte cap.
 * @returns the normalized leading words within both limits.
 */
export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger('maxWords', maxWords)
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords)
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd()
}

/** StudyClaw fallback policy: dsh production caps (5 words / 40 bytes) fit the sidebar row. */
export const FALLBACK_TITLE_MAX_WORDS = 5
export const FALLBACK_TITLE_MAX_BYTES = 40

/** Convenience wrapper applying StudyClaw's fallback policy to a first user message. */
export function studyclawFallbackTitle(input: string): string {
  return fallbackSessionTitle(input, FALLBACK_TITLE_MAX_WORDS, FALLBACK_TITLE_MAX_BYTES)
}
