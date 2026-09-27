/**
 * LLM task generator: ConceptChunk → HarnessTask batch via structured calls
 * with error-feedback retries (Python `task_gen.py::LlmTaskGenerator`
 * parity). The client seam is the dsh adapter stream; validation is zod.
 * @module @studyclaw/course-builder/src/task-gen
 */

import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { generatedTaskBatch, type GeneratedTask, type HarnessTask, type IngestArtifact } from './models.ts'
import { taskGeneratorUser, TASK_GENERATOR_SYSTEM, type TaskGenerationTarget } from './prompts.ts'
import { structuredCall, type StructuredCallClient } from './structured.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export const DEFAULT_MAX_RETRIES = 3

/**
 * 批内显式规格轮换（题卡质量 A 档）：修复"每批两张固定一易一难 → 全池难度
 * 只有 2/4"与"正确项位置连续同位"两个病灶。计数器按生成进程推进。
 */
const TYPE_WHEEL: Array<GeneratedTask['type']> = ['concept', 'scenario', 'debug_edge']
const DIFFICULTY_WHEEL = [1, 3, 5, 2, 4]
const ANSWER_POSITION_WHEEL = [0, 2, 1, 3]

let generationCounter = 0

export interface GenerationTarget {
  type: 'concept' | 'scenario' | 'debug_edge'
  difficulty: number
  answerPosition: number
}

/** 为一批 count 张卡计算显式生成规格。 */
export function generationTargets(count: number, offset = generationCounter): TaskGenerationTarget[] {
  return Array.from({ length: count }, (_unused, index) => {
    const slot = offset + index
    return {
      type: TYPE_WHEEL[slot % TYPE_WHEEL.length]!,
      difficulty: DIFFICULTY_WHEEL[slot % DIFFICULTY_WHEEL.length]!,
      answerPosition: ANSWER_POSITION_WHEEL[slot % ANSWER_POSITION_WHEEL.length]!,
    }
  })
}

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
    // offset 的读取与计数器推进必须同步完成（await 之前）：build 以
    // maxConcurrency=4 并发跑批，若沿用"成功后才递增"，同一并发窗口内的
    // 各批会读到相同 offset，type/difficulty/答案位轮换在并发下整体失效。
    // 失败批次会跳过若干轮换槽位——对多样性无影响，可接受。
    const offset = generationCounter
    generationCounter += count
    const targets = generationTargets(count, offset)
    const batch = await structuredCall(
      this.client,
      generatedTaskBatch,
      this.generateOptions(chunk.title, chunk.content, count, targets),
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

  private generateOptions(title: string, content: string, count: number, targets?: TaskGenerationTarget[]): Omit<GenerateOptions, 'tools'> {
    return {
      provider: this.options.provider,
      model: this.options.model,
      system: TASK_GENERATOR_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: taskGeneratorUser(title, content, count, '', targets) }], source: { kind: 'user' } })],
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
