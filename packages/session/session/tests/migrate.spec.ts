import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacySession } from '../src/migrate.ts'
import { SessionEventStore } from '../src/events.ts'
import { SessionStore } from '../src/store.ts'

describe('migrateLegacySession', () => {
  it('creates an event log and leaves a legacy backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-'))
    await mkdir(root, { recursive: true })
    const source = join(root, 'session_20260822-120000.jsonl')
    await writeFile(source, [
      JSON.stringify({ type: 'session_meta', title: '', mode: 'socratic', created_at: '2026-08-22T12:00:00.000Z' }),
      JSON.stringify({ type: 'chat', ts: '2026-08-22T12:00:01.000Z', role: 'user', content: 'hello' }),
      JSON.stringify({ type: 'chat', ts: '2026-08-22T12:00:02.000Z', role: 'agent', content: 'world', mode: 'socratic' }),
    ].join('\n') + '\n', 'utf8')
    const result = await migrateLegacySession(root, '20260822-120000')
    expect(result.migrated).toBe(true)
    expect(await readFile(`${source}.legacy`, 'utf8')).toBe(await readFile(source, 'utf8'))
    await expect(new SessionEventStore(root).project('20260822-120000')).resolves.toMatchObject({
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
    })
    await rm(root, { recursive: true, force: true })
  })

  it('preserves session model effort while migrating legacy history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-effort-'))
    const source = join(root, 'session_20260822-120000.jsonl')
    await writeFile(source, [
      JSON.stringify({ type: 'session_meta', title: '', mode: 'socratic', created_at: '2026-08-22T12:00:00.000Z' }),
      JSON.stringify({ type: 'session_model', ts: '2026-08-22T12:00:01.000Z', provider: 'acme', model: 'acme-small', effort: 'high' }),
    ].join('\n') + '\n', 'utf8')
    await migrateLegacySession(root, '20260822-120000')
    const rows = await new SessionEventStore(root).load('20260822-120000')
    expect(rows.find(row => row.type === 'session/model')?.payload).toMatchObject({ provider: 'acme', model: 'acme-small', effort: 'high' })
    await rm(root, { recursive: true, force: true })
  })

  it('rejects malformed legacy rows without creating an event file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-invalid-'))
    await writeFile(join(root, 'session_20260822-120000.jsonl'), '{"type":"unknown"}\n', 'utf8')
    await expect(migrateLegacySession(root, '20260822-120000')).rejects.toThrow('旧会话第 1 行无效')
    await expect(readFile(join(root, 'session_20260822-120000.events.jsonl'), 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('reports malformed JSON with its source line and leaves the legacy file untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-json-'))
    const source = join(root, 'session_20260822-120000.jsonl')
    const raw = '{"type":"session_meta","title":"x","mode":"socratic","created_at":"2026-08-22T12:00:00.000Z"}\nnot-json\n'
    await writeFile(source, raw, 'utf8')
    await expect(migrateLegacySession(root, '20260822-120000')).rejects.toThrow('旧会话第 2 行不是有效 JSON')
    expect(await readFile(source, 'utf8')).toBe(raw)
    await expect(readFile(join(root, 'session_20260822-120000.events.jsonl'), 'utf8')).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it('is idempotent and retains the legacy backup on repeat migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-repeat-'))
    const source = join(root, 'session_20260822-120000.jsonl')
    await writeFile(source, JSON.stringify({ type: 'session_meta', title: '旧标题', mode: 'socratic', created_at: '2026-08-22T12:00:00.000Z' }) + '\n', 'utf8')
    const first = await migrateLegacySession(root, '20260822-120000')
    const second = await migrateLegacySession(root, '20260822-120000')
    expect(first.migrated).toBe(true)
    expect(second).toMatchObject({ migrated: false, backupFile: `${source}.legacy`, events: 1 })
    await rm(root, { recursive: true, force: true })
  })

  it('keeps migrated metadata immutable and appends rename to the event log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-migrate-rename-'))
    const source = join(root, 'session_20260822-120000.jsonl')
    await writeFile(source, JSON.stringify({ type: 'session_meta', title: '旧标题', mode: 'socratic', created_at: '2026-08-22T12:00:00.000Z' }) + '\n', 'utf8')
    await migrateLegacySession(root, '20260822-120000')
    const legacyBefore = await readFile(source, 'utf8')
    await new SessionStore(root).renameSession('20260822-120000', '新标题')
    expect(await readFile(source, 'utf8')).toBe(legacyBefore)
    expect((await new SessionStore(root).listSessions())[0]?.title).toBe('新标题')
    await rm(root, { recursive: true, force: true })
  })
})
