/**
 * Agent-scoped runtime facts shared by Host, CLI, ACP, Web and presets.
 *
 * This is intentionally dependency-free. DSH keeps these facts on the live
 * Agent scope; StudyClaw exposes the same contract without requiring the
 * Cordis graph so every entry point can use one runtime object.
 */

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly effort?: string | null
}

export interface AgentCapability {
  readonly id: string
  readonly available: boolean
  readonly reason?: string | null
  readonly installAction?: string | null
}

export interface AgentScope {
  readonly agentId: string
  readonly sessionId: string
  readonly cwd: string
  readonly workspaceRoot?: string
  readonly courseId?: string
}

export interface AgentPreset {
  readonly id: string
  readonly label?: string
  readonly systemPrompt?: string
  readonly toolNames?: readonly string[]
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AgentPromptContext) => string | Promise<string>)
}

export interface AgentPromptContext {
  readonly scope: AgentScope
  readonly model: AgentModelSelection | null
  readonly capabilities: readonly AgentCapability[]
  readonly preset: AgentPreset
}

/** Immutable facts captured when one Agent is created. */
export interface AgentRuntimeState {
  readonly scope: AgentScope
  readonly cwd: string
  readonly capabilities: readonly AgentCapability[]
  readonly preset: AgentPreset
  readonly permissionPreset: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly systemPrompt: string
  readonly modelSelection: AgentModelSelection | null
}

/**
 * Small DSH-compatible prompt registry. Registrations are deterministic and
 * duplicate names fail early, which keeps prompt assembly replayable.
 */
export class SystemPromptRegistry {
  private readonly sections = new Map<string, PromptSection>()

  register(section: PromptSection): () => void {
    if (this.sections.has(section.name)) throw new Error(`system prompt section already registered: ${section.name}`)
    this.sections.set(section.name, section)
    return () => {
      if (this.sections.get(section.name) === section) this.sections.delete(section.name)
    }
  }

  list(): PromptSection[] {
    return [...this.sections.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  async assemble(context: AgentPromptContext): Promise<string> {
    const parts: string[] = []
    for (const section of this.list()) {
      const value = typeof section.text === 'function' ? await section.text(context) : section.text
      const text = value.trim()
      if (text !== '') parts.push(interpolatePrompt(text, context))
    }
    return parts.join('\n\n')
  }
}

export function interpolatePrompt(text: string, context: AgentPromptContext): string {
  const values: Record<string, string> = {
    agent_id: context.scope.agentId,
    session_id: context.scope.sessionId,
    cwd: context.scope.cwd,
    preset: context.preset.id,
    provider: context.model?.provider ?? '',
    model: context.model?.model ?? '',
  }
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, name: string) => values[name] ?? '')
}

export function createAgentRuntimeState(input: {
  agentId: string
  sessionId: string
  cwd: string
  capabilities?: readonly AgentCapability[]
  preset?: AgentPreset
  permissionPreset?: AgentRuntimeState['permissionPreset']
  systemPrompt?: string
  modelSelection?: AgentModelSelection | null
  workspaceRoot?: string
  courseId?: string
}): AgentRuntimeState {
  const preset = input.preset ?? { id: 'general', label: 'General Agent' }
  const scope: AgentScope = {
    agentId: input.agentId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.courseId === undefined ? {} : { courseId: input.courseId }),
  }
  return {
    scope,
    cwd: input.cwd,
    capabilities: [...(input.capabilities ?? [])],
    preset,
    permissionPreset: input.permissionPreset ?? 'workspace-write',
    systemPrompt: input.systemPrompt ?? preset.systemPrompt ?? '',
    modelSelection: input.modelSelection ?? null,
  }
}
