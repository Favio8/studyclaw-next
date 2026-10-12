import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { courseSourceRoot, resolveSourceRef } from '@studyclaw/tools'
import { ReadingService } from '../src/reading.ts'
import { readParsedText, saveParsedManifest, writeParsedText } from '@studyclaw/course-builder'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-source-boundary-'))
  roots.push(root)
  const project = join(root, 'project'), outside = join(root, 'outside')
  await mkdir(project); await mkdir(outside)
  await writeFile(join(outside, 'note.md'), 'OUTSIDE FIXTURE')
  await symlink(outside, join(project, 'linked'), 'junction')
  return { project, outside }
}

describe('全部资料读取入口共享真实路径边界', () => {
  it('解析缓存目录的外部链接不能用于读写', async () => {
    const { project, outside } = await fixture()
    const state = join(project, '.studyclaw')
    await mkdir(state)
    await symlink(outside, join(state, 'parsed'), 'junction')
    expect(await readParsedText(state, 'note.md')).toBeNull()
    await expect(writeParsedText(state, 'cache.md', 'FIXTURE')).rejects.toThrow(/链接越界/)
  })

  it('缓存写入拒绝带父目录的文件名', async () => {
    const { project } = await fixture()
    await expect(writeParsedText(join(project, '.studyclaw'), '../../escape.md', 'FIXTURE')).rejects.toThrow(/basename/)
  })

  it('解析 manifest 的 out 不能穿越 parsed/ 读取外部 Markdown', async () => {
    const { project } = await fixture()
    const source = 'a.docx', content = 'DOCX FIXTURE'
    await writeFile(join(project, source), content)
    await saveParsedManifest(join(project, '.studyclaw'), {
      [source]: { sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`, engine: 'mineru', tier: 'basic', out: '../../../outside/note.md' },
    })
    const payload = await new ReadingService().parsed(project, source)
    expect(payload.available).toBe(false)
    expect(payload.markdown).toBe('')
  })

  it('reading.text 拒绝经目录链接读取课程外文本', async () => {
    const { project } = await fixture()
    await expect(new ReadingService().readText(project, 'linked/note.md')).rejects.toThrow(/符号链接|越界/)
  })

  it('resolveSourceRef 同时保护 reading.file 的 PDF 字节入口', async () => {
    const { project, outside } = await fixture()
    await writeFile(join(outside, 'note.pdf'), 'PDF FIXTURE')
    await expect(resolveSourceRef(project, 'linked/note.pdf')).rejects.toThrow(/符号链接|越界/)
  })

  it('源根绑定到工作区外的 junction 时回退项目根', async () => {
    const { project } = await fixture()
    await writeFile(join(project, '.source-root.json'), JSON.stringify({ path: 'linked' }))
    expect(await courseSourceRoot(project)).toBe(project)
  })

  it('指向隐藏状态的可见链接不得绕过隐藏目录守卫', async () => {
    const { project } = await fixture()
    await mkdir(join(project, '.studyclaw'))
    await writeFile(join(project, '.studyclaw', 'notes.md'), 'STATE FIXTURE')
    await symlink(join(project, '.studyclaw'), join(project, 'public-state'), 'junction')
    await expect(resolveSourceRef(project, 'public-state/notes.md')).rejects.toThrow(/隐藏|状态/)
  })

  it('允许内部资料链接，缺失资料保持 exists=false', async () => {
    const { project } = await fixture()
    await mkdir(join(project, 'docs'))
    await writeFile(join(project, 'docs', 'note.md'), '# 原文')
    await symlink(join(project, 'docs'), join(project, 'alias'), 'junction')
    expect((await new ReadingService().readText(project, 'alias/note.md')).text).toBe('# 原文')
    expect((await new ReadingService().load(project, 'missing.pdf')).exists).toBe(false)
  })
});
