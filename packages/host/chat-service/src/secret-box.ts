/**
 * Workspace credential sealing (P0-2 / SEC-7).
 *
 * Threat model: the workspace folder itself gets zipped/shared — so the API
 * keys must not survive in plaintext inside `.studyclaw/credentials.json`.
 * The AES-256-GCM master key lives OUTSIDE any workspace, under
 * `$STUDYCLAW_HOME` or `~/.studyclaw/master.key` (0600), making key theft
 * require stealing a file from the user's home directory as well.
 * Plaintext files written by older builds are detected on read and migrated
 * to sealed form by the settings layer.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
const SEALED_MARKER = '"sealed": true'
const KEY_BYTES = 32

export function masterKeyPath(): string {
  const home = process.env.STUDYCLAW_HOME ?? join(homedir(), '.studyclaw')
  return join(home, 'master.key')
}

/** Load or lazily create the per-user master key (hex-encoded 256-bit). */
export async function ensureMasterKey(): Promise<Buffer> {
  const path = masterKeyPath()
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing !== null) {
    const hex = existing.trim()
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
    //损坏的密钥文件直接重建会锁死旧密文，因此这里显式报错而不是覆盖。
    throw new Error(`master.key 内容无效（应为 64 位十六进制）: ${path}`)
  }
  await mkdir(dirname(path), { recursive: true })
  const fresh = randomBytes(KEY_BYTES)
  await writeFileAtomicRestricted(path, fresh.toString('hex') + '\n')
  return fresh
}

/** The only writer for master.key and credentials.json: random tmp name,
 * exclusive-create with owner-only mode, fsync, then rename over target. */
async function writeFileAtomicRestricted(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
    await handle.close()
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Seal a credentials object into a self-describing JSON envelope. */
export async function sealCredentials(credentials: Record<string, string>): Promise<string> {
  const key = await ensureMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(credentials, null, 2), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope = {
    version: 1,
    sealed: true,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return JSON.stringify(envelope, null, 2)
}

export interface UnsealResult {
  readonly data: Record<string, string>
  /** true when the file was legacy plaintext (needs migration). */
  readonly wasPlaintext: boolean
}

/**
 * Read either sealed or legacy-plaintext credentials. Decryption failure is
 * loud: silently returning {} would turn an unrelated master.key into
 * "no provider configured" without explaining why.
 */
export async function unsealCredentials(raw: string): Promise<UnsealResult> {
  const trimmed = raw.trim()
  if (trimmed === '') return { data: {}, wasPlaintext: false }
  if (!trimmed.includes(SEALED_MARKER)) {
    const parsed = JSON.parse(trimmed) as unknown
    return {
      data: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string> : {},
      wasPlaintext: true,
    }
  }
  const envelope = JSON.parse(trimmed) as { iv?: string; tag?: string; ciphertext?: string }
  if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('凭据信封缺少字段，无法解密')
  }
  const key = await ensureMasterKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
  return {
    data: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string> : {},
    wasPlaintext: false,
  }
}

export { writeFileAtomicRestricted }
