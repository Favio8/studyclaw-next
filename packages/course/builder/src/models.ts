/**
 * Course domain models (zod), ported from Python `schemas.py` for the
 * builder/learning surface: Syllabus/Chapter/Concept/ConceptChunk/SourceRef,
 * HarnessTask/EvaluationCriteria/TaskHistory, and the ingest artifact.
 * @module @studyclaw/course-builder/src/models
 */

import { z } from 'zod'

export const conceptType = z.enum(['mechanism', 'practice', 'scenario'])
export type ConceptType = z.infer<typeof conceptType>

export const taskType = z.enum(['concept', 'scenario', 'debug_edge'])
export type TaskType = z.infer<typeof taskType>

export const sourceRef = z.object({
  file: z.string(),
  chunk_id: z.string().optional(),
  line_range: z.array(z.number()).optional(),
})
export type SourceRef = z.infer<typeof sourceRef>

export const concept = z.object({
  id: z.string(),
  name: z.string(),
  type: conceptType.default('mechanism'),
  prerequisites: z.array(z.string()).default([]),
  mastery_score: z.number().default(0),
})
export type Concept = z.infer<typeof concept>

export const chapter = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  dependencies: z.array(z.string()).default([]),
  concepts: z.array(concept).default([]),
})
export type Chapter = z.infer<typeof chapter>

export const syllabus = z.object({
  course_id: z.string(),
  title: z.string(),
  version: z.string().default('1.0.0'),
  granularity: z.enum(['fine', 'coarse']).default('fine'),
  chapters: z.array(chapter).default([]),
  adjacency: z.record(z.string(), z.array(z.string())).default({}),
})
export type Syllabus = z.infer<typeof syllabus>

export const conceptChunk = z.object({
  chunk_id: z.string(),
  chapter_id: z.string(),
  concept_id: z.string(),
  title: z.string(),
  content: z.string(),
  source_ref: sourceRef,
})
export type ConceptChunk = z.infer<typeof conceptChunk>

export const ingestArtifact = z.object({
  source_file: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
  syllabus: syllabus,
  chunks: z.array(conceptChunk).default([]),
})
export type IngestArtifact = z.infer<typeof ingestArtifact>

export const evaluationCriteria = z.object({
  rubric: z.array(z.string()).min(2).max(4),
  keywords: z.array(z.string()).default([]),
  misattribution_options: z.array(z.string()).default(['概念混淆', '推导漏洞', '边界遗漏', '无']),
})
export type EvaluationCriteria = z.infer<typeof evaluationCriteria>

export const taskHistory = z.object({
  attempts: z.number().default(0),
  last_score: z.number().nullable().default(null),
  pass_count: z.number().default(0),
  last_review_at: z.string().nullable().default(null),
  next_review_at: z.string().nullable().default(null),
  ef: z.number().default(2.5),
})
export type TaskHistory = z.infer<typeof taskHistory>

export const harnessTask = z.object({
  task_id: z.string(),
  concept_id: z.string(),
  source_ref: sourceRef.nullable().default(null),
  type: taskType,
  difficulty: z.number().int().min(1).max(5),
  question: z.string(),
  options: z.array(z.string()).nullable().default(null),
  evaluation_criteria: evaluationCriteria,
  history: taskHistory,
  deprecated: z.boolean().default(false),
  dynamic: z.boolean().default(false),
  target_id: z.string().nullable().default(null),
})
export type HarnessTask = z.infer<typeof harnessTask>

/** LLM structured-output view of one task (ids/history filled by the system). */
export const generatedTask = z.object({
  type: taskType,
  difficulty: z.number().int().min(1).max(5),
  question: z.string(),
  options: z.array(z.string()).nullable().default(null),
  evaluation_criteria: evaluationCriteria,
})
export type GeneratedTask = z.infer<typeof generatedTask>

export const generatedTaskBatch = z.object({
  tasks: z.array(generatedTask).min(1),
})
export type GeneratedTaskBatch = z.infer<typeof generatedTaskBatch>

/** LLM 结构化输出：一个概念的先修依赖表（id 引用合法性由 sanitize 保证）。 */
export const conceptDependency = z.object({
  conceptId: z.string(),
  prerequisites: z.array(z.string()).default([]),
})
export type ConceptDependency = z.infer<typeof conceptDependency>

export const dependencyBatch = z.object({
  conceptDependencies: z.array(conceptDependency).default([]),
})
export type DependencyBatch = z.infer<typeof dependencyBatch>
