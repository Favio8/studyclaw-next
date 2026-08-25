/**
 * StudyClaw 前端类型契约 (T0.3).
 *
 * 与后端 `src/studyclaw/core/schemas.py`（Pydantic v2）**1:1 对齐**：
 * - 字段名 = API 线上的 camelCase alias（pydantic `to_camel` 生成，见 api_spec.md §1）；
 * - 枚举值与 Python Enum 的 value 完全一致；
 * - 任何一侧新增/改名字段，必须同步另一侧并通过 `scripts/check_types.mjs` 对拍。
 *
 * 上游契约：PRD §5 / file_contracts.md / api_spec.md。
 */

// ---------------------------------------------------------------------------
// Enums（PRD §5.2 / §6 / file_contracts §3.3 / §3.4）
// ---------------------------------------------------------------------------

/** 四大学习模式（PRD §6.4）。 */
export const LearningMode = {
  Socratic: "socratic",
  Quick: "quick",
  Feynman: "feynman",
  Debug: "debug",
} as const;
export type LearningMode = (typeof LearningMode)[keyof typeof LearningMode];

/** 题卡三维出题矩阵（PRD §5.2）。 */
export const TaskType = {
  Concept: "concept", // 概念辨析
  Scenario: "scenario", // 场景决策
  DebugEdge: "debug_edge", // 边界与排错
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/** 微概念类型（file_contracts §3.1）。 */
export const ConceptType = {
  Mechanism: "mechanism",
  Scenario: "scenario",
  Practice: "practice",
} as const;
export type ConceptType = (typeof ConceptType)[keyof typeof ConceptType];

/** 核心错因归因标签（file_contracts §3.3，固定枚举，值为中文）。 */
export const MisattributionTag = {
  ConceptConfusion: "概念混淆",
  DerivationGap: "推导漏洞",
  BoundaryMiss: "边界遗漏",
  None: "无",
} as const;
export type MisattributionTag =
  (typeof MisattributionTag)[keyof typeof MisattributionTag];

/** history/*.jsonl 行类型（file_contracts §3.4）。 */
export const HistoryLineType = {
  SessionMeta: "session_meta",
  Chat: "chat",
  Eval: "eval",
  Sync: "sync",
  Tool: "tool",
  Ask: "ask",
} as const;
export type HistoryLineType =
  (typeof HistoryLineType)[keyof typeof HistoryLineType];

// ---------------------------------------------------------------------------
// 基础别名类型
// ---------------------------------------------------------------------------

/** 概念 ID，格式 `c_[A-Za-z0-9_]+`。 */
export type ConceptId = string;
/** 章节 ID，格式 `chap_[A-Za-z0-9_]+`。 */
export type ChapterId = string;
/** 掌握度分数，范围 [0, 1]。 */
export type MasteryScore = number;
/** ISO 8601 UTC 时间字符串。 */
export type IsoDateTime = string;
/** ISO 日期字符串（YYYY-MM-DD）。 */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Syllabus — 双层知识拓扑（file_contracts §3.1 / PRD §5.1）
// ---------------------------------------------------------------------------

/** 微概念节点（概念级 DAG）。 */
export interface Concept {
  id: ConceptId;
  name: string;
  type: ConceptType;
  prerequisites: ConceptId[];
  masteryScore: MasteryScore;
}

/** 章节节点（章节级 DAG）。 */
export interface Chapter {
  id: ChapterId;
  title: string;
  description: string;
  dependencies: ChapterId[];
  concepts: Concept[];
}

/** syllabus.json 顶层结构；ID 前缀与无环 DAG 为硬约束（后端校验）。 */
export interface Syllabus {
  courseId: string;
  title: string;
  version: string;
  /** F7 大纲粒度：coarse=粗粒度大章节(3~5) | fine=高密度微概念(15~30)。 */
  granularity: "fine" | "coarse";
  chapters: Chapter[];
}

// ---------------------------------------------------------------------------
// Ingestor output — 知识切片（T1.1 产物）
// ---------------------------------------------------------------------------

/** 切片/题卡对原始资料的溯源引用。 */
export interface SourceRef {
  file: string;
  chunkId: string;
  /** JSON 线上格式为 [start, end] 二元数组（1-based，闭区间）。 */
  lineRange: [number, number];
}

/** Ingestor 切片产物：一段带溯源的知识切片。 */
export interface ConceptChunk {
  chunkId: string;
  chapterId: ChapterId | null;
  conceptId: ConceptId | null;
  title: string;
  content: string;
  sourceRef: SourceRef;
}

// ---------------------------------------------------------------------------
// Harness task — 题卡（PRD §5.2 / file_contracts §3.2）
// ---------------------------------------------------------------------------

/** Rubric 采分契约：2~4 条互斥要点，命中即得分。 */
export interface EvaluationCriteria {
  rubric: string[]; // 2~4 条
  keywords: string[];
  minScoreToPass: number; // (0, 1]
}

/** 作答历史摘要（只增改 history 字段，永不改写题目本体）。 */
export interface TaskHistory {
  attempts: number;
  passCount: number;
  lastScore: MasteryScore | null;
  lastAttemptAt: IsoDateTime | null;
}

/** tasks/task_xxxx.json 题卡主体（文件名 = task_<四位序号>.json）。 */
export interface HarnessTask {
  taskId: string;
  conceptId: ConceptId;
  sourceRef: SourceRef | null;
  type: TaskType;
  difficulty: number; // 1~5
  question: string;
  /** 选择题专用；简答题为 null。GET /quiz 不含答案。 */
  options: string[] | null;
  evaluationCriteria: EvaluationCriteria;
  history: TaskHistory;
  /** 作废不删除，保留审计。 */
  deprecated: boolean;
  /** 动态靶向题（F5）：标记变体/反例题。 */
  dynamic: boolean;
  /** targetid：关联来源对话轮次/误区标签。 */
  targetId: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation — 评测结果（PRD §5.3 / api_spec §4.2 result 帧）
// ---------------------------------------------------------------------------

/** Rubric 二元判定结果；rubricHits 为「采分点 -> 命中与否」。 */
export interface EvaluationResult {
  taskId: string;
  conceptId: ConceptId;
  score: MasteryScore;
  passed: boolean;
  rubricHits: Record<string, boolean>;
  feedback: string;
  misconceptions: string[];
  suggestedReviewDays: number | null;
}

// ---------------------------------------------------------------------------
// Progress — 动态看板（PRD §5.4 / file_contracts §3.3 / api_spec §2.4）
// ---------------------------------------------------------------------------

/** progress.md 明细表一行（9 列契约）。 */
export interface ProgressRecord {
  conceptId: ConceptId;
  name: string;
  chapter: string;
  mastery: MasteryScore;
  evals: number;
  passRate: MasteryScore;
  /** SM-2 遗忘因子，下限 1.3。 */
  ef: number;
  nextReviewAt: IsoDate | null;
  misattribution: MisattributionTag;
}

/** progress.md 头部元信息 + 明细表（GET /courses/{id}/progress）。 */
export interface ProgressBoard {
  overallMastery: MasteryScore;
  dueCount: number;
  lastUpdatedAt: IsoDateTime | null;
  concepts: ProgressRecord[];
}

// ---------------------------------------------------------------------------
// History lines — 会话与评测轨迹（file_contracts §3.4，多会话）
// ---------------------------------------------------------------------------

/** 会话文件首行元信息；title 缺省取首条 user chat 前 20 字符。 */
export interface SessionMetaLine {
  type: typeof HistoryLineType.SessionMeta;
  title: string;
  mode: LearningMode;
  createdAt: IsoDateTime;
}

export interface ChatLine {
  type: typeof HistoryLineType.Chat;
  ts: IsoDateTime;
  /** "user" | "agent" */
  role: string;
  content: string;
  mode: LearningMode | null;
}

export interface EvalLine {
  type: typeof HistoryLineType.Eval;
  ts: IsoDateTime;
  taskId: string;
  conceptId: ConceptId;
  score: MasteryScore;
  passed: boolean;
  rubricHits: Record<string, boolean>;
  misconceptions: string[];
}

export interface SyncLine {
  type: typeof HistoryLineType.Sync;
  ts: IsoDateTime;
  target: string;
  summary: string;
}
export interface ToolLine {
  type: typeof HistoryLineType.Tool;
  ts: IsoDateTime;
  name: string;
  /** "success" | "degraded" | "rejected" */
  status: string;
  args: Record<string, unknown>;
  summary: string;
  error: string | null;
  durationMs: number;
}

export interface AskLine {
  type: typeof HistoryLineType.Ask;
  ts: IsoDateTime;
  question: string;
  /** "pending" | "answered" */
  status: string;
  answer: string | null;
}


/** 按 `type` 字段判别的联合类型。 */
export type HistoryLine = SessionMetaLine | ChatLine | EvalLine | SyncLine | ToolLine | AskLine;

// ---------------------------------------------------------------------------
// [STUDYCLAW_SYNC] 回写协议载荷（file_contracts §4.2，Agent 隐藏块）
// ---------------------------------------------------------------------------

export interface ConceptScoreUpdate {
  id: ConceptId;
  score: MasteryScore;
}

/** Agent 输出中被系统拦截的结构化状态声明（不展示给用户）。 */
export interface SyncBlock {
  conceptUpdates: ConceptScoreUpdate[];
  memoryHints: string[];
  changelog: string;
}

// ---------------------------------------------------------------------------
// Workspace config — .studyclaw/config.yaml（file_contracts §2.1）
// ---------------------------------------------------------------------------

export interface LlmConfig {
  provider: string;
  model: string;
  /** 只允许环境变量注入，禁止明文密钥。 */
  apiKeyEnv: string;
  /** OpenAI 兼容网关/代理（如 opencode-go）时填写。 */
  apiBase?: string | null;
  temperature: number; // [0, 2]
  maxConcurrency: number;
}

export interface PluginsConfig {
  ingestor: string;
  taskGenerator: string;
  evaluator: string;
  scheduler: string;
}

export interface UiConfig {
  defaultMode: LearningMode;
}

export interface StudyClawConfig {
  version: number;
  llm: LlmConfig;
  providers: Record<string, ProviderProfile>;
  activeProvider: string;
  plugins: PluginsConfig;
  ui: UiConfig;
}

/** Provider 模型目录条目（模型配置 Tab 内可编辑的最小单元）。 */
export interface ProviderModelDef {
  id: string;
  name: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

/** Provider 档案：一个可切换的 LLM 路由（密钥不写在配置内）。 */
export interface ProviderProfile {
  id: string;
  name: string;
  model: string;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  temperature: number; // [0, 2]
  maxConcurrency: number;
  models: ProviderModelDef[];
}

// ---------------------------------------------------------------------------
// API 传输模型（api_spec.md v1.2；由 FastAPI 端点直接消费，无 Python 对应模型）
// ---------------------------------------------------------------------------

/** GET /courses 列表项（api_spec §2.2）。 */
export interface CourseSummary {
  id: string;
  title: string;
  overallMastery: MasteryScore;
  dueToday: number;
  lastActiveAt: IsoDateTime | null;
}

/** GET /courses/{id}/sessions 列表项（api_spec §3.2，左栏会话列表数据源）。 */
export interface SessionSummary {
  sessionId: string;
  title: string;
  mode: LearningMode;
  createdAt: IsoDateTime;
  lastActiveAt: IsoDateTime;
  turns: number;
}

/** GET /session 会话恢复响应（api_spec §3.4）。 */
export interface SessionRestore {
  sessionId: string;
  restored: boolean;
  turns: ChatLine[];
  suggestedEntry: string;
}

/** GET /quiz 题卡摘要（api_spec §4.1，不含 evaluationCriteria 与答案）。 */
export interface QuizTaskSummary {
  taskId: string;
  conceptId: ConceptId;
  type: TaskType;
  difficulty: number;
  question: string;
  options: string[] | null;
}

/** GET /metrics/heatmap 单日格（api_spec §5.1）。 */
export interface HeatmapDay {
  date: IsoDate;
  score: number;
  /** 0(0分) 1(1~3) 2(4~7) 3(8+) */
  level: 0 | 1 | 2 | 3;
  tasks: number;
  chatTurns: number;
  weakSpotsCleared: number;
}

/** GET /metrics/heatmap 响应（api_spec §5.1）。 */
export interface HeatmapResponse {
  weeks: number;
  days: HeatmapDay[];
  streak: { current: number; best: number };
}

/** GET /metrics/heatmap/day 时光机回放（api_spec §5.2）。 */
export interface HeatmapDayDetail {
  date: IsoDate;
  changelog: string[];
  events: Array<{
    ts: IsoDateTime;
    type: string;
    taskId?: string;
    passed?: boolean;
  }>;
}

/** GET /mastery 章节聚合掌握度（api_spec §5.3，拓扑图节点着色数据）。 */
export interface MasteryChapter {
  id: ChapterId;
  mastery: MasteryScore;
  concepts: Array<{
    id: ConceptId;
    mastery: MasteryScore;
    /** locked(<前置未达) | learning | weak | mastered */
    status: "locked" | "learning" | "weak" | "mastered";
  }>;
}

/** GET /jobs/{jobId} 异步构建任务（api_spec §2.3）。 */
export interface JobStatus {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  progress: { total: number; finished: number; currentFile: string } | null;
  result: { syllabusVersion: string; tasksGenerated: number } | null;
}

/** POST /chat/stream 请求体（api_spec §3.1）。 */
export interface ChatStreamRequest {
  courseId: string;
  conceptId?: ConceptId;
  mode: LearningMode;
  /** 省略 = 最近活跃会话。 */
  sessionId?: string;
  message: string;
  /** 当前课程根目录下、以相对路径表示的文件引用。 */
  fileRefs?: string[];
}

/** 通用错误响应体（api_spec §1）。 */
export interface ApiError {
  error: {
    code:
      | "WORKSPACE_NOT_INITIALIZED"
      | "COURSE_NOT_FOUND"
      | "CONCEPT_NOT_FOUND"
      | "TASK_NOT_FOUND"
      | "LLM_API_ERROR"
      | "LLM_TIMEOUT"
      | "SCHEMA_INVALID"
      | "FILE_LOCKED"
      | "INTERNAL_ERROR";
    message: string;
    detail: unknown;
  };
}
