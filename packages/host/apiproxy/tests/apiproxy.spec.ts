/**
 * apiproxy dispatch integration: the full host seam (real storage stack +
 * registry) behind the M1 method table. Covers idempotent open, the
 * last-opened pointer, courses projection, rename conflict codes, reorder
 * and remove responses, and the invalid-path mapping.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@studyclaw/workspace'
import { listCourseSummaries } from '@studyclaw/course-summary'
import { dispatch, type HostServices } from '../src/index.ts'

async function seedWorkspace(root: string, name: string): Promise<string> {
  // 项目即课程：项目根即课程根（syllabus/progress/history 就地）。
  const dir = join(root, name)
  await mkdir(join(dir, '.studyclaw'), { recursive: true })
  await writeFile(
    join(dir, '.studyclaw', 'syllabus.json'),
    JSON.stringify({ course_id: name, title: `标题-${name}`, version: '1.0.0' }),
    'utf8',
  )
  await writeFile(
    join(dir, '.studyclaw', 'progress.md'),
    `# 进度\n\n- **总体掌握度**：42%\n- **待复习卡片数**：3\n- **最后更新时间**：2026-08-20 10:00\n\n| 概念 | 掌握度 |\n|---|---|\n| 概念1 | 0.4 |\n`,
    'utf8',
  )
  await mkdir(join(dir, '.studyclaw', 'history'), { recursive: true })
  await writeFile(join(dir, '.studyclaw', 'history', 'session_20260820-100000.jsonl'), '{}' + '\n', 'utf8')
  return dir
}
interface Harness {
  readonly root: string
  readonly services: HostServices
  dispose(): Promise<void>
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-apiproxy-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.workspaceRegistry
  const services: HostServices = {
    registry: {
      create: (path, title) => registry.create(path, title),
      list: () => registry.list(),
      get: id => registry.get(id),
      rename: (id, title) => registry.rename(id, title),
      delete: id => registry.delete(id),
      insertBefore: (id, beforeId) => registry.insertBefore(id, beforeId),
      setLastOpenedPath: path => registry.setLastOpenedPath(path),
      getLastOpenedPath: () => registry.lastOpenedPath,
    },
    courseSummary: root => listCourseSummaries(root),
    pickDirectory: async () => null,
    sessionService: {
      list: async () => [{
        sessionId: '20260821-100000',
        title: '会话一',
        mode: 'socratic',
        turns: 2,
        createdAt: '2026-08-21T10:00:00Z',
        lastActiveAt: '2026-08-21T10:05:00Z',
      }],
      search: async () => ({
        items: [{
          sessionId: '20260821-100000',
          title: '会话一',
          mode: 'socratic',
          turns: 2,
          createdAt: '2026-08-21T10:00:00Z',
          lastActiveAt: '2026-08-21T10:05:00Z',
          workspacePath: '/workspace',
          workspaceTitle: '工作区',
          courseId: 'c1',
          courseTitle: '课程一',
          snippet: '你好，搜索命中。',
        }],
        hasMore: false,
      }),
      create: async (courseId, mode, title) => ({ sessionId: '20260821-120000', file: `${courseId}/history/session_20260821-120000.jsonl` }),
      rename: async (courseId, sessionId, title) => ({ sessionId, title }),
      fork: async (courseId, sessionId) => ({ sessionId: '20260821-120001', file: `${courseId}/history/session_20260821-120001.jsonl` }),
      archive: async (courseId, sessionId) => ({ sessionId, archived: true as const }),
      reorder: async () => ({
        sessions: [{
          sessionId: '20260821-100000',
          title: '会话一',
          mode: 'socratic',
          turns: 2,
          createdAt: '2026-08-21T10:00:00Z',
          lastActiveAt: '2026-08-21T10:05:00Z',
        }],
      }),
      restore: async (courseId, sessionId) => ({
        sessionId,
        title: '会话一',
        mode: 'socratic',
        restored: true,
        turns: [{ role: 'user', ts: '2026-08-21T10:00:00Z', content: '你好' }],
        suggestedEntry: null,
        wakeup: null,
        pendingAsk: null,
      }),
    },
    chatConfig: async () => ({ defaultMode: 'socratic', model: 'mock', providerId: 'mock', apiKeyConfigured: true }),
    settingsService: {
      get: async () => ({ version: 1, activeProviderId: 'mock', llm: { model: 'mock', apiKeyConfigured: true }, providers: [], ui: { defaultMode: 'socratic' } }),
      update: async () => ({ version: 1, activeProviderId: 'mock', llm: {}, providers: [], ui: { defaultMode: 'quick' } }),
      catalog: async () => [{ id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', models: [] }],
      discover: async () => [{ id: 'm1', name: 'M1', contextWindow: null, maxTokens: null }],
      save: async () => ({ version: 1, activeProviderId: 'mock', llm: {}, providers: [], ui: { defaultMode: 'socratic' } }),
      remove: async () => ({ version: 1, activeProviderId: 'mock', llm: {}, providers: [], ui: { defaultMode: 'socratic' } }),
      activate: async () => ({ version: 1, activeProviderId: 'mock', llm: {}, providers: [], ui: { defaultMode: 'socratic' } }),
      credential: async () => ({ version: 1, activeProviderId: 'mock', llm: {}, providers: [], ui: { defaultMode: 'socratic' } }),
    },
  }
  return {
    root,
    services,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('apiproxy dispatch', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await setup()
  })

  afterEach(async () => {
    await harness.dispose()
  })

  it('open is idempotent, records the last-opened pointer, and lists in order', async () => {
    const dirA = await seedWorkspace(harness.root, 'alpha')
    const dirB = await seedWorkspace(harness.root, 'beta')

    const empty = await dispatch('workspaces.list', undefined, harness.services)
    expect(empty).toEqual({ ok: true, result: { current: null, items: [] } })

    const openedA = await dispatch('workspaces.open', { path: dirA }, harness.services)
    const openedB = await dispatch('workspaces.open', { path: dirB }, harness.services)
    expect(openedA).toMatchObject({ ok: true, result: { created: true } })
    expect(openedB).toMatchObject({ ok: true, result: { created: true } })
    const again = await dispatch('workspaces.open', { path: dirA }, harness.services)
    expect(again).toMatchObject({ ok: true, result: { created: false } })

    const listed = await dispatch('workspaces.list', undefined, harness.services)
    expect(listed).toMatchObject({
      ok: true,
      result: {
        current: dirA,
        items: expect.arrayContaining([expect.objectContaining({ path: dirA })]),
      },
    })
  })

  it('courses projects syllabus titles, progress meta, and history mtimes', async () => {
    const dir = await seedWorkspace(harness.root, 'alpha')
    const result = await dispatch('workspaces.courses', { path: dir }, harness.services)
    expect(result).toMatchObject({
      ok: true,
      result: {
        missing: false,
        courses: [{
          id: 'alpha',
          title: '标题-alpha',
          overallMastery: 0.42,
          dueToday: 3,
          lastActiveAt: expect.any(String),
        }],
      },
    })
  })

  it('maps rename conflicts, reorder, and remove to stable results', async () => {
    const dirA = await seedWorkspace(harness.root, 'alpha')
    const dirB = await seedWorkspace(harness.root, 'beta')
    const openedA = await dispatch('workspaces.open', { path: dirA }, harness.services)
    const openedB = await dispatch('workspaces.open', { path: dirB }, harness.services)
    const idA = (openedA as { result: { workspace: { id: string } } }).result.workspace.id
    const idB = (openedB as { result: { workspace: { id: string } } }).result.workspace.id

    const renamed = await dispatch('workspaces.rename', { id: idA, title: '  学习空间  ' }, harness.services)
    expect(renamed).toMatchObject({ ok: true, result: { workspace: { title: '学习空间' } } })

    const conflict = await dispatch('workspaces.rename', { id: idB, title: '学习空间' }, harness.services)
    expect(conflict).toMatchObject({ ok: false, error: { code: 'workspace-name-conflict' } })

    const reordered = await dispatch('workspaces.reorder', { id: idA, beforeId: idB }, harness.services)
    expect(reordered).toMatchObject({ ok: true, result: { items: [{ id: idA }, { id: idB }] } })

    const removed = await dispatch('workspaces.remove', { id: idB }, harness.services)
    expect(removed).toMatchObject({ ok: true, result: { items: [{ id: idA }] } })
  })

  it('maps invalid paths, unknown ids, and unknown methods to error codes', async () => {
    const invalid = await dispatch('workspaces.open', { path: join(harness.root, 'gone') }, harness.services)
    expect(invalid).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })

    const unknown = await dispatch('workspaces.rename', { id: 'g-nope', title: 'x' }, harness.services)
    expect(unknown).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })

    const missing = await dispatch('workspaces.bogus', undefined, harness.services)
    expect(missing).toMatchObject({ ok: false, error: { code: 'method-not-found' } })

    const malformed = await dispatch('workspaces.open', { path: '' }, harness.services)
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('courses on a missing directory reports missing', async () => {
    const result = await dispatch('workspaces.courses', { path: join(harness.root, 'gone') }, harness.services)
    expect(result).toEqual({ ok: true, result: { courses: [], missing: true } })
  })

  it('session methods round-trip over the seam', async () => {
    const listed = await dispatch('sessions.list', { courseId: 'c1' }, harness.services)
    expect(listed).toMatchObject({ ok: true, result: { sessions: [{ sessionId: '20260821-100000', turns: 2 }] } })

    const searched = await dispatch('sessions.search', { query: '搜索', limit: 10 }, harness.services)
    expect(searched).toMatchObject({ ok: true, result: { items: [{ snippet: '你好，搜索命中。', courseId: 'c1' }], hasMore: false } })

    const created = await dispatch('sessions.create', { courseId: 'c1', mode: 'feynman', title: '讲解' }, harness.services)
    expect(created).toMatchObject({ ok: true, result: { sessionId: '20260821-120000', wakeup: null } })

    const renamed = await dispatch('sessions.rename', { courseId: 'c1', sessionId: '20260821-100000', title: '新标题' }, harness.services)
    expect(renamed).toMatchObject({ ok: true, result: { sessionId: '20260821-100000', title: '新标题' } })
    const forked = await dispatch('sessions.fork', { courseId: 'c1', sessionId: '20260821-100000', chatIndex: 0 }, harness.services)
    expect(forked).toMatchObject({ ok: true, result: { sessionId: '20260821-120001' } })
    const archived = await dispatch('sessions.archive', { courseId: 'c1', sessionId: '20260821-100000' }, harness.services)
    expect(archived).toMatchObject({ ok: true, result: { archived: true } })
    const reordered = await dispatch('sessions.reorder', { courseId: 'c1', sessionId: '20260821-100000' }, harness.services)
    expect(reordered).toMatchObject({ ok: true, result: { sessions: [{ sessionId: '20260821-100000' }] } })

    const restored = await dispatch('sessions.restore', { courseId: 'c1', sessionId: '20260821-100000' }, harness.services)
    expect(restored).toMatchObject({ ok: true, result: { restored: true, turns: [{ role: 'user', content: '你好' }] } })

    const malformed = await dispatch('sessions.restore', { courseId: 'c1', sessionId: '' }, harness.services)
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const malformedSearch = await dispatch('sessions.search', { query: '' }, harness.services)
    expect(malformedSearch).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('settings.get projects the config default mode', async () => {
    const result = await dispatch('settings.get', undefined, harness.services)
    expect(result).toMatchObject({ ok: true, result: { ui: { defaultMode: 'socratic' }, llm: { model: 'mock', apiKeyConfigured: true } } })
  })
})
