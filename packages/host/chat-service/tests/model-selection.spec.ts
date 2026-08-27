import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,  join } from 'node:path'
import { createSession, selectSessionModel, sessionModels } from '../src/service.ts'
import { configForSession } from '../src/course.ts'
import { LearningAgentService } from '../src/service.ts'
import { AgentRegistry } from '@studyclaw/agent'
import { SessionEventStore, SessionStore, sessionModelLine, utcTs } from '@studyclaw/session'
import { activateProvider, saveProvider, setCredential } from '../src/settings.ts'

async function setup(): Promise<{ root: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-model-selection-'))
  await mkdir(join(root, '.studyclaw', 'history'), { recursive: true })
  await writeFile(join(root, '.studyclaw-placeholder'), '', 'utf8')
  const saved = await saveProvider(root, {
    id: 'acme', name: 'Acme', model: 'acme-small', baseUrl: 'https://acme.example/v1',
    temperature: 0.3, maxConcurrency: 1,
    models: [
      { id: 'acme-small', name: 'Acme Small', contextWindow: null, maxTokens: null },
      { id: 'acme-large', name: 'Acme Large', contextWindow: null, maxTokens: null },
    ],
  })
  void saved
  await setCredential(root, 'acme', 'test-key')
  await activateProvider(root, 'acme')
  const created = await createSession(root, basename(root), 'socratic', null)
  return { root, sessionId: created.sessionId }
}

describe('session model directory', () => {
  it('lists configured models and persists a session-level selection', async () => {
    const { root, sessionId } = await setup()
    const first = await sessionModels(root, basename(root), sessionId)
    expect(first.current).toEqual({ provider: 'acme', model: 'acme-small' })
    expect(first.routable).toBe(true)
    expect(first.groups[0]?.models.map(model => model.id)).toEqual(['acme-small', 'acme-large'])
    expect(first.groups[0]?.models[0]?.efforts?.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])

    await selectSessionModel(root, basename(root), sessionId, { provider: 'acme', model: 'acme-large', effort: 'high' })
    const next = await sessionModels(root, basename(root), sessionId)
    expect(next.current).toEqual({ provider: 'acme', model: 'acme-large', effort: 'high' })
    const history = await readFile(join(root, '.studyclaw', 'history', `session_${sessionId}.jsonl`), 'utf8')
    expect(history).toContain('"type":"session_model"')
    expect(history).toContain('"effort":"high"')
    await rm(root, { recursive: true, force: true })
  })

  it('rejects an unsupported effort without replacing the current selection', async () => {
    const { root, sessionId } = await setup()
    await expect(selectSessionModel(root, basename(root), sessionId, { provider: 'acme', model: 'acme-large', effort: 'ultra' }))
      .rejects.toThrow('思考强度不可用')
    await expect(sessionModels(root, basename(root), sessionId)).resolves.toMatchObject({
      current: { provider: 'acme', model: 'acme-small' },
    })
    await rm(root, { recursive: true, force: true })
  })

  it('does not expose obsolete DeepSeek defaults and reports an unroutable empty setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-model-empty-'))
    await mkdir(join(root, '.studyclaw', 'history'), { recursive: true })
    const created = await createSession(root, basename(root), 'socratic', null)
    const directory = await sessionModels(root, basename(root), created.sessionId)
    expect(directory.current).toBeNull()
    expect(directory.routable).toBe(false)
    expect(directory.groups.flatMap(group => group.models.map(model => model.id))).not.toContain('deepseek-chat')
    expect(directory.groups.flatMap(group => group.models.map(model => model.id))).not.toContain('deepseek-reasoner')
    await rm(root, { recursive: true, force: true })
  })

  it('updates a live Agent immediately after the session selection is persisted', async () => {
    const { root, sessionId } = await setup()
    const service = new LearningAgentService(new AgentRegistry())
    await service.register(root, basename(root), sessionId, 'socratic')
    await selectSessionModel(root, basename(root), sessionId, { provider: 'acme', model: 'acme-large' })
    await service.selectModel(sessionId, { provider: 'acme', model: 'acme-large' })
    expect(service.status(`study-${sessionId}`).modelSelection).toEqual({ provider: 'acme', model: 'acme-large' })
    await service.dispose(`study-${sessionId}`)
    await rm(root, { recursive: true, force: true })
  })

  it('resolves learning actions from the event-log model selection', async () => {
    const { root, sessionId } = await setup()
    const events = new SessionEventStore(join(root, '.studyclaw', 'history'))
    await events.append(sessionId,
      { ts: utcTs(), type: 'session/create', payload: { mode: 'socratic' } },
      { ts: utcTs(), type: 'session/model', payload: { provider: 'acme', model: 'acme-large' } },
    )
    await new SessionStore(join(root, '.studyclaw', 'history')).append(sessionId,
      sessionModelLine.parse({ type: 'session_model', ts: utcTs(), provider: 'acme', model: 'acme-small' }),
    )
    const directory = await sessionModels(root, basename(root), sessionId)
    expect(directory.current).toEqual({ provider: 'acme', model: 'acme-large' })
    const resolved = await configForSession(root, basename(root), sessionId, null)
    expect(resolved).toMatchObject({ providerId: 'acme', model: 'acme-large', apiKey: 'test-key' })
    await rm(root, { recursive: true, force: true })
  })
})
