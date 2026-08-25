/**
 * Line schemas for the session JSONL store, ported from Python
 * `schemas.py` (SessionMetaLine / ChatLine / ToolLine / AskLine / SyncLine /
 * SyncBlock / ConceptScoreUpdate / LearningMode). Field names stay snake_case
 * on the wire (file contract §4.4); zod validates every line at the
 * durable boundary.
 * @module @studyclaw/session/src/models
 */

import { z } from 'zod'

export const LEARNING_MODES = ['socratic', 'quick', 'feynman', 'debug'] as const
export type LearningMode = (typeof LEARNING_MODES)[number]

export const learningMode = z.enum(LEARNING_MODES)

export const sessionMetaLine = z.object({
  type: z.literal('session_meta'),
  title: z.string(),
  mode: learningMode.default('socratic'),
  created_at: z.string(),
})
export type SessionMetaLine = z.infer<typeof sessionMetaLine>

export const sessionModelLine = z.object({
  type: z.literal('session_model'),
  ts: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
})
export type SessionModelLine = z.infer<typeof sessionModelLine>

export const chatLine = z.object({
  type: z.literal('chat'),
  ts: z.string(),
  role: z.enum(['user', 'agent']),
  content: z.string(),
  mode: learningMode.optional(),
})
export type ChatLine = z.infer<typeof chatLine>

export const toolLine = z.object({
  type: z.literal('tool'),
  ts: z.string(),
  name: z.string(),
  status: z.enum(['success', 'degraded', 'rejected']),
  args: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().default(''),
  error: z.string().nullable().default(null),
  duration_ms: z.number().default(0),
})
export type ToolLine = z.infer<typeof toolLine>

export const askLine = z.object({
  type: z.literal('ask'),
  ts: z.string(),
  question: z.string(),
  status: z.enum(['pending', 'answered']),
  answer: z.string().optional(),
})
export type AskLine = z.infer<typeof askLine>

export const syncLine = z.object({
  type: z.literal('sync'),
  ts: z.string(),
  target: z.string(),
  summary: z.string(),
})
export type SyncLine = z.infer<typeof syncLine>

export const conceptScoreUpdate = z.object({
  id: z.string(),
  score: z.number().min(0).max(1),
})
export type ConceptScoreUpdate = z.infer<typeof conceptScoreUpdate>

/** The [STUDYCLAW_SYNC] payload shape (schema-validated before apply). */
export const syncBlock = z.object({
  concept_updates: z.array(conceptScoreUpdate).default([]),
  memory_hints: z.array(z.string()).default([]),
  changelog: z.string().optional(),
})
export type SyncBlock = z.infer<typeof syncBlock>

/** One stored line, discriminated by `type`. */
export const historyLine = z.discriminatedUnion('type', [
  sessionMetaLine,
  sessionModelLine,
  chatLine,
  toolLine,
  askLine,
  syncLine,
])

export type HistoryLine = z.infer<typeof historyLine>
