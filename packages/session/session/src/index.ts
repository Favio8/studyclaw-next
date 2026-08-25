/**
 * StudyClaw session domain: JSONL session store, streaming splitters,
 * context assembly, and the tutor chat loop (ported from Python
 * `core/session.py`). M2 scope: four-mode chat with tool loop and sync
 * application; the task pool / evaluator backends land at M3/M4.
 * @module @studyclaw/session
 */

export {
  SessionStore,
  SessionError,
  utcTs,
} from './store.ts'
export type { SessionSummary } from './store.ts'
export {
  streamSplit,
  extractSync,
  parseFull,
  ToolStreamSplitter,
  SYNC_MARKER,
  SYNC_KEY,
} from './splitter.ts'
export type { StreamEvent, ParsedTurn } from './splitter.ts'
export {
  ContextAssembler,
  loadCourseState,
} from './context.ts'
export type { CourseState } from './context.ts'
export { SyncApplier } from './applier.ts'
export {
  TutorSession,
  publicToolArgs,
  DEFAULT_TOOL_LOOP_LIMIT,
} from './session.ts'
export type { ChatEvent, ToolCall, ToolLlmClient } from './session.ts'
export {
  LEARNING_MODES,
  learningMode,
  sessionMetaLine,
  sessionModelLine,
  chatLine,
  toolLine,
  askLine,
  syncLine,
  syncBlock,
  conceptScoreUpdate,
  historyLine,
} from './models.ts'
export type {
  LearningMode,
  SessionMetaLine,
  SessionModelLine,
  ChatLine,
  ToolLine,
  AskLine,
  SyncLine,
  SyncBlock,
  ConceptScoreUpdate,
} from './models.ts'
export { SessionEventStore, sessionEventEnvelope } from './events.ts'
export type { SessionEventEnvelope, SessionProjection, SessionEventMap, SessionEventName, KnownSessionEventEnvelope, TurnEndReason } from './events.ts'
export { migrateLegacySession } from './migrate.ts'
export type { SessionMigrationResult } from './migrate.ts'
