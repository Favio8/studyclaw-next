import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,  join } from 'node:path'
import { AgentRegistry } from '@studyclaw/agent'
import { SessionEventStore } from '@studyclaw/session'
import { LearningAgentService } from '../src/service.ts'
import { updateSettings } from '../src/settings.ts'

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return await read()
}

describe('LearningAgentService durable runtime state', () => {
  it('persists inbox sends and exposes the original turn stream by turnId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-inbox-service-'))
    await mkdir(join(root, '.studyclaw', 'history'), { recursive: true })
    const service = new LearningAgentService(new AgentRegistry())
    const created = await service.create(root, basename(root), 'socratic', 'inbox test')
    const queued = await service.send(root, basename(root), created.sessionId, 'socratic', 'queued message')
    expect(String(queued.turnId)).not.toBe('')
    const eventStore = new SessionEventStore(join(root, '.studyclaw', 'history'))
    const rows = await waitFor(
      () => eventStore.load(created.sessionId),
      value => value.some(row => row.type === 'inbox/queued' && row.payload['turnId'] === queued.turnId),
    )
    expect(rows.some(row => row.type === 'inbox/queued' && row.payload['turnId'] === queued.turnId)).toBe(true)
    const events: string[] = []
    await expect((async () => {
      for await (const event of service.queuedEvents(String(queued.agentId), String(queued.turnId))) events.push(event.type)
    })()).rejects.toThrow('未配置模型供应商')
    expect(events).toContain('turn/error')
    await service.dispose(created.agentId)
    await rm(root, { recursive: true, force: true })
  })

  it('persists maintenance jobs and keeps an Agent runtime snapshot stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-agent-service-'))
    await mkdir(join(root, '.studyclaw', 'history'), { recursive: true })
    await updateSettings(root, { agentPreset: 'general', permissionPreset: 'read-only', plugins: { learning: false, sandbox: true } })

    const registry = new AgentRegistry()
    const service = new LearningAgentService(registry)
    const created = await service.create(root, basename(root), 'socratic', 'runtime test')
    const initial = await service.projection(created.agentId)
    expect(initial.agentConfig).toMatchObject({ agentPreset: 'general', permissionPreset: 'read-only', plugins: { learning: false, sandbox: true } })

    await updateSettings(root, { agentPreset: 'studyclaw-learning', permissionPreset: 'danger-full-access', plugins: { learning: true, sandbox: false } })
    const unchanged = await service.projection(created.agentId)
    expect(unchanged.agentConfig).toEqual(initial.agentConfig)

    const queued = await service.maintenance(created.agentId, 'checkpoint', 'test checkpoint')
    expect(queued).toMatchObject({ agentId: created.agentId, kind: 'checkpoint', status: 'queued', summary: 'test checkpoint' })
    const jobs = await waitFor(() => service.maintenanceJobs(created.agentId), value => value[0]?.status === 'done')
    expect(jobs[0]).toMatchObject({ jobId: queued.jobId, status: 'done', error: null })
    const events = await service.projection(created.agentId)
    expect(events.maintenanceJobs[0]).toMatchObject({ jobId: queued.jobId, status: 'done' })

    await service.dispose(created.agentId)
    await rm(root, { recursive: true, force: true })
  })
})
