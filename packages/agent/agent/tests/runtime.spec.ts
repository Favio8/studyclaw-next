import { describe, expect, it } from 'vitest'
import { SystemPromptRegistry, createAgentRuntimeState } from '../src/index.ts'

describe('agent runtime contract', () => {
  it('assembles ordered scoped prompt sections with model variables', async () => {
    const state = createAgentRuntimeState({
      agentId: 'a1',
      sessionId: 's1',
      cwd: 'C:/workspace',
      preset: { id: 'learning' },
      modelSelection: { provider: 'mock', model: 'alpha' },
    })
    const registry = new SystemPromptRegistry()
    registry.register({ name: 'late', order: 10, text: 'model={{model}}' })
    registry.register({ name: 'early', order: -10, text: 'agent={{agent_id}} cwd={{cwd}}' })
    await expect(registry.assemble({
      scope: state.scope,
      model: state.modelSelection,
      capabilities: state.capabilities,
      preset: state.preset,
    })).resolves.toBe('agent=a1 cwd=C:/workspace\n\nmodel=alpha')
  })

  it('rejects duplicate section names', () => {
    const registry = new SystemPromptRegistry()
    registry.register({ name: 'persona', order: 0, text: 'one' })
    expect(() => registry.register({ name: 'persona', order: 1, text: 'two' })).toThrow('already registered')
  })
})
