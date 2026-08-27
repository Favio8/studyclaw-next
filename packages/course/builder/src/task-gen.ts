/**
 * LLM task generator: ConceptChunk → HarnessTask batch via structured calls
 * with error-feedback retries (Python `task_gen.py::LlmTaskGenerator`
 * parity). The client seam is the dsh adapter stream; validation is zod.
 * @module @studyclaw/course-builder/src/task-gen
 */

import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { generatedTaskBatch, type HarnessTask, type IngestArtifact } from './models.ts'
import { structuredCall, type StructuredCallClient } from './structured.ts'
import { TASK_GENERATOR_SYSTEM, taskGeneratorUser } from './prompts.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export const DEFAULT_MAX_RETRIES = 3

export class TaskGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskGenerationError'
  }
}

export interface LlmTaskGeneratorOptions {
  maxRetries?: number
  model: string
  provider: string
  temperature?: number
}

/** Structured task generation over one dsh-adapter stream client. */
export class LlmTaskGenerator {
  constructor(
    private readonly client: StructuredCallClient,
    private readonly options: LlmTaskGeneratorOptions,
  ) {}

  async generateTasks(chunk: IngestArtifact['chunks'][number], count = 2): Promise<HarnessTask[]> {
    const batch = await structuredCall(
      this.client,
      generatedTaskBatch,
      this.generateOptions(chunk.title, chunk.content, count),
      this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
    )
    return batch.tasks.map((task, index) => ({
      ...task,
      // F-14：批内唯一编号（_001/_002…），不再整批共用 _001——否则评测
      // find(task_id) 永远命中第一张，分数记到错误题卡头上。
      task_id: this.taskId(chunk.concept_id, index + 1),
      concept_id: chunk.concept_id,
      source_ref: chunk.source_ref,
      history: { attempts: 0, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
      deprecated: false,
      dynamic: false,
      target_id: null,
    }))
  }

  private generateOptions(title: string, content: string, count: number): Omit<GenerateOptions, 'tools'> {
    return {
      provider: this.options.provider,
      model: this.options.model,
      system: TASK_GENERATOR_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: taskGeneratorUser(title, content, count) }], source: { kind: 'user' } })],
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    }
  }

  private taskId(conceptId: string, sequence: number): string {
    const prefix = conceptId.replace(/^c_/, '')
    return `${prefix}_${String(sequence).padStart(3, '0')}`
  }
}

export const generatedTaskSchema = generatedTaskBatch
export { z }
