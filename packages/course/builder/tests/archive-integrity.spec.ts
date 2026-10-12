import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ install: false, denied: '' }))
vi.mock('@studyclaw/fs-atomic', async importOriginal => {
  const actual = await importOriginal<typeof import('@studyclaw/fs-atomic')>()
  return { ...actual, renameWithRetry: async (from: string, to: string) => {
    if (fault.install && from.includes('.studyclaw-import-')) {
      fault.install = false
      throw Object.assign(new Error('INJECTED INSTALL FAILURE'), { code: 'EIO' })
    }
    return actual.renameWithRetry(from, to)
  } }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]) === fault.denied) {
      return Promise.reject(Object.assign(new Error('INJECTED READ FAILURE'), { code: 'EACCES' }))
    }
    return actual.readFile(...args)
  } }
})

import { createCourseBackup, loadCourseExportData, renderCourseMarkdown } from '../src/export.ts'
import { importCourseBackup } from '../src/import.ts'
import { createZip, readZip } from '../src/zip.ts'

const roots: string[] = []
afterEach(async () => {
  fault.install = false
  fault.denied = ''
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-archive-integrity-'))
  roots.push(root)
  const course = join(root, 'course')
  await mkdir(join(course, '.studyclaw'), { recursive: true })
  await writeFile(join(course, '.studyclaw', 'notes.md'), 'new notes')
  return { root, course }
}

describe('archive integrity across real disk operations', () => {
  it('rejects damaged JSON or persisted structures before replacing existing data', async () => {
    const { root } = await fixture()
    const target = join(root, 'target')
    const old = join(target, 'course')
    await mkdir(old, { recursive: true })
    await writeFile(join(old, 'original.txt'), 'irreplaceable data')
    for (const [path, raw] of [
      ['.studyclaw/syllabus.json', '{broken'],
      ['.studyclaw/annotations.json', 'null'],
      ['.studyclaw/annotations.json', '{"version":1,"sources":{"a":{"progress":{"page":0,"percent":0,"updatedAt":""},"highlights":[]}}}'],
      ['.studyclaw/tasks/task_0001.json', '{}'],
    ]) {
      const archive = createZip([
        { path: 'studyclaw-export.json', data: Buffer.from(JSON.stringify({ studyclaw_export: 1, course_id: 'course' })) },
        { path: path!, data: Buffer.from(raw!) },
      ])
      await expect(importCourseBackup(archive, target, { force: true })).rejects.toMatchObject({ code: 'invalid-archive' })
      expect(await readFile(join(old, 'original.txt'), 'utf8')).toBe('irreplaceable data')
      expect(await readdir(target)).toEqual(['course'])
    }
  })
  it('restores the old directory at its original path when installation fails after retirement', async () => {
    const { root, course } = await fixture()
    const archive = await createCourseBackup(course)
    const target = join(root, 'target')
    const old = join(target, 'course')
    await mkdir(old, { recursive: true })
    await writeFile(join(old, 'original.txt'), 'irreplaceable data')
    fault.install = true
    await expect(importCourseBackup(archive, target, { force: true })).rejects.toThrow('INJECTED INSTALL FAILURE')
    expect(await readFile(join(old, 'original.txt'), 'utf8')).toBe('irreplaceable data')
    expect(await readdir(target)).toEqual(['course'])
  })

  it('does not label an unreadable state file as a successful complete backup', async () => {
    const { course } = await fixture()
    fault.denied = join(course, '.studyclaw', 'notes.md')
    await expect(createCourseBackup(course)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a state directory junction pointing at credentials outside the course', async () => {
    const { root, course } = await fixture()
    const secrets = join(root, 'private')
    await mkdir(secrets)
    await writeFile(join(secrets, 'notes.md'), 'sk-secret-canary'.repeat(500))
    await rm(join(course, '.studyclaw'), { recursive: true })
    await symlink(secrets, join(course, '.studyclaw'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createCourseBackup(course)).rejects.toThrow(/symbolic|符号链接/)
    await expect(loadCourseExportData(course, 'course')).rejects.toThrow(/symbolic|符号链接/)
  })

  it('backs up malformed JSON bytes intact while Markdown reports the damaged section', async () => {
    const { course } = await fixture()
    const state = join(course, '.studyclaw')
    await writeFile(join(state, 'syllabus.json'), '{broken')
    await writeFile(join(state, 'annotations.json'), 'null')
    const archive = await createCourseBackup(course)
    expect(readZip(archive).find(entry => entry.path === '.studyclaw/syllabus.json')!.data.toString()).toBe('{broken')
    const markdown = renderCourseMarkdown(await loadCourseExportData(course, 'course'))
    expect(markdown).toContain('标注文件损坏')
    expect(markdown).toContain('new notes')
  })
})
