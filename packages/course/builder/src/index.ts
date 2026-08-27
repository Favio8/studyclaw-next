/**
 * Course build engine: markdown ingest, checksum incrementality, syllabus
 * merge, task pool, progress seeding, and structured LLM task generation.
 * @module @studyclaw/course-builder
 */

export { MarkdownIngestor, slug, conceptTypeOf, IngestError, DEFAULT_MAX_CHUNK_CHARS } from './ingestor.ts'
export { CourseBuilder, computeChecksums, loadSyllabus, loadTaskPool, writeTaskPool, BuildError, DEFAULT_SOURCE_EXTENSIONS, COURSE_STATE_FILES, stateDirOf, migrateLegacyLayout } from './builder.ts'
export type { BuildReport } from './builder.ts'
export { extractSourceText, extractTextToMarkdown, ExtractionError, EXTRACTED_EXTENSIONS } from './extract.ts'
export { LlmTaskGenerator, TaskGenerationError, DEFAULT_MAX_RETRIES } from './task-gen.ts'
export type { TaskGenerator } from './builder.ts'
export { structuredCall, extractJsonObject } from './structured.ts'
export type { StructuredCallClient } from './structured.ts'
export {
  DependencyInferrer,
  sanitizeDependencies,
  acyclicEdges,
  normalizeDependencies,
  graphAdjacency,
  projectChapterDependencies,
} from './dep-infer.ts'
export type { DepInferrerOptions, DependencyInferenceResult, DependencyInferrerLike } from './dep-infer.ts'
export {
  checkSyllabusQuality,
  applySyllabusQualityGuard,
  normalizeName,
  MAX_CONCEPT_NAME_LENGTH,
  MAX_CHAPTERS,
  MAX_CONCEPTS,
  MAX_CHAPTERS_FINE,
} from './quality-guard.ts'
export type { SyllabusQualityIssue, SyllabusQualityIssueCode } from './quality-guard.ts'
export {
  syllabus,
  chapter,
  concept,
  conceptChunk,
  ingestArtifact,
  harnessTask,
  evaluationCriteria,
  taskHistory,
  generatedTaskBatch,
  conceptDependency,
  dependencyBatch,
} from './models.ts'
export type {
  Syllabus,
  Chapter,
  Concept,
  ConceptChunk,
  IngestArtifact,
  HarnessTask,
  EvaluationCriteria,
  TaskHistory,
  TaskType,
  ConceptType,
  ConceptDependency,
  DependencyBatch,
} from './models.ts'
export { TASK_GENERATOR_SYSTEM, EVALUATOR_SYSTEM, DYNAMIC_CARD_SYSTEM, DEP_INFER_SYSTEM, taskGeneratorUser, evaluatorUser, dynamicCardUser, depInferUser } from './prompts.ts'
export { buildDefaultSpecs } from '@studyclaw/tools'
export {
  loadProgressBoard,
  saveProgressBoard,
  upsertProgressRecord,
  dueRecords,
  scoreToQuality,
  updateEf,
  intervalDays,
  reviewSchedule,
} from './progress.ts'
export type { ProgressBoard, ProgressRecord } from './progress.ts'
