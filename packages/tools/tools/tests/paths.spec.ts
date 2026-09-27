/**
 * paths.ts 单元回归（第五轮对抗性审查）：
 * - T-2：`.source-root.json` 绑定目标零校验 → 污染仓库可把资料根指到工作区外，
 *   read_source/search_sources 以任意目录为根越界读。绑定必须限定在 courseDir 内；
 * - T-1：Windows 8.3 短名别名（STUDYC~1 ↔ .studyclaw）realpath 不展开、字符串
 *   containment 放行——以 `~数字` 结尾的路径段必须被拒绝（判定为纯字符串规则，
 *   跨平台可测；合法名 backup~1.txt 不受影响）。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { courseSourceRoot, isEightDotThreeSegment } from '../src/paths.ts'

const workspace = await mkdtemp(join(tmpdir(), 'studyclaw-paths-in-'))
const outside = await mkdtemp(join(tmpdir(), 'studyclaw-paths-out-'))
await mkdir(join(workspace, 'materials'), { recursive: true })
await writeFile(join(outside, 'secret.md'), 'outside', 'utf8')

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('courseSourceRoot 绑定 containment（T-2）', () => {
  it('指向工作区外的绑定被忽略，回退规范的项目根', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-bind-evil-'))
    try {
      await writeFile(join(root, '.source-root.json'), JSON.stringify({ path: outside }), 'utf8')
      expect(await courseSourceRoot(root)).toBe(resolve(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('指向工作区内的相对绑定被采纳', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-bind-ok-'))
    try {
      await mkdir(join(root, 'materials'), { recursive: true })
      await writeFile(join(root, '.source-root.json'), JSON.stringify({ path: './materials' }), 'utf8')
      expect(await courseSourceRoot(root)).toBe(resolve(root, 'materials'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('无绑定/绑定损坏时回退项目根', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-bind-none-'))
    try {
      expect(await courseSourceRoot(root)).toBe(resolve(root))
      await writeFile(join(root, '.source-root.json'), 'not json', 'utf8')
      expect(await courseSourceRoot(root)).toBe(resolve(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('isEightDotThreeSegment（T-1）', () => {
  it('命中 8.3 别名形态', () => {
    expect(isEightDotThreeSegment('STUDYC~1')).toBe(true)
    expect(isEightDotThreeSegment('NODE_M~1')).toBe(true)
    expect(isEightDotThreeSegment('progra~2')).toBe(true)
  })

  it('不误伤合法文件名', () => {
    expect(isEightDotThreeSegment('backup~1.txt')).toBe(false)
    expect(isEightDotThreeSegment('notes~2.md')).toBe(false)
    expect(isEightDotThreeSegment('~1')).toBe(false)
    expect(isEightDotThreeSegment('a~b')).toBe(false)
    expect(isEightDotThreeSegment('.studyclaw')).toBe(false)
  })
})
