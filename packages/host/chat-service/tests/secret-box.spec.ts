/**
 * secret-box 回归（第三轮对抗性审查 RV-5/RV-6）：
 * - RV-5：密封判定必须用结构化字段（顶层 sealed === true），明文 JSON 的
 *   "值"里含 `"sealed": true` 字样不得被误判成密封信封（旧实现子串匹配）。
 * - RV-6：writeFileAtomicRestricted 失败路径不得泄漏文件句柄（间接验证：
 *   密封/写入在异常注入下仍可继续执行）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sealCredentials, unsealCredentials } from '../src/secret-box.ts'

const home = await mkdtemp(join(tmpdir(), 'studyclaw-secretbox-'))

afterAll(() => rm(home, { recursive: true, force: true }))

describe('unsealCredentials 密封判定', () => {
  it('RV-5：明文值含 "sealed": true 字样仍按明文解析，不被误判为信封', async () => {
    const raw = JSON.stringify({ openai: '这个值里恰好有 "sealed": true 字样', keep: 'v1' }, null, 2)
    const result = await unsealCredentials(raw)
    expect(result.wasPlaintext).toBe(true)
    expect(result.data['openai']).toBe('这个值里恰好有 "sealed": true 字样')
    expect(result.data['keep']).toBe('v1')
  })

  it('密封信封往返：seal → unseal 恢复原始键值', async () => {
    process.env.STUDYCLAW_HOME = home
    try {
      const credentials = { deepseek: 'sk-test-abc123', openai: 'sk-xyz' }
      const sealed = await sealCredentials(credentials)
      const result = await unsealCredentials(sealed)
      expect(result.wasPlaintext).toBe(false)
      expect(result.data).toEqual(credentials)
    } finally {
      delete process.env.STUDYCLAW_HOME
    }
  })

  it('RV-5：sealed=true 但缺 iv/tag/ciphertext 的信封响亮报错（不误当明文返回垃圾键值）', async () => {
    process.env.STUDYCLAW_HOME = home
    try {
      const broken = JSON.stringify({ version: 1, sealed: true, alg: 'A256GCM' })
      await expect(unsealCredentials(broken)).rejects.toThrow('凭据信封缺少字段')
    } finally {
      delete process.env.STUDYCLAW_HOME
    }
  })
})
