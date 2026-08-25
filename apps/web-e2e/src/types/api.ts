/**
 * StudyClaw API 传输类型（api_spec v1.2，T3.x）。
 *
 * 与 `types/index.ts`（Pydantic 对拍契约）分离：本文件只描述 HTTP
 * 响应负载形态（服务层组装的 camelCase 视图模型），不参与 parity 对拍。
 */

export interface CourseSummary {
  id: string;
  title: string;
  overallMastery: number;
  dueToday: number;
  lastActiveAt: string | null;
}

export interface ProviderModelPayload {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface ProviderPayload {
  id: string;
  name: string;
  model: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  apiKeyConfigured: boolean;
  temperature: number;
  maxConcurrency: number;
  models: ProviderModelPayload[];
}

/** 内置供应商目录条目（api_spec §2.8 v2.6）。 */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  baseUrl: string | null;
  models: ProviderModelPayload[];
}

export interface SettingsPayload {
  version: number;
  activeProviderId: string;
  llm: {
    provider: string;
    model: string;
    apiKeyEnv: string;
    apiBase: string | null;
    temperature: number;
    maxConcurrency: number;
    apiKeyConfigured: boolean;
  };
  providers: ProviderPayload[];
  ui: { defaultMode: "socratic" | "quick" | "feynman" | "debug" };
}

/** 工作区注册表条目（dsh 语义：uuid 键 + canonical 路径，持久化于宿主）。 */
export interface WorkspaceItem {
  id: string;
  path: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRegistryPayload {
  current: string | null;
  items: WorkspaceItem[];
}

/** 打开/接管一个本地工作区的响应（M1：course/session 字段在 M2/M3 回归）。 */
export interface OpenWorkspaceResponse {
  workspace: WorkspaceItem;
  created: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  mode: string;
  turns: number;
  createdAt: string;
  lastActiveAt: string;
}

/** A global JSONL search hit with its workspace and course location. */
export interface SessionSearchResult extends SessionSummary {
  workspacePath: string;
  workspaceTitle: string;
  courseId: string;
  courseTitle: string;
  snippet?: string;
}

export interface SessionSearchResponse {
  items: SessionSearchResult[];
  hasMore: boolean;
}

export interface WakeupCard {
  taskId: string;
  conceptId: string;
  type: string;
  difficulty: number;
  question: string;
  options: string[] | null;
  skippable: boolean;
}

export interface RestoredSession {
  sessionId: string;
  title: string;
  mode: string;
  restored: boolean;
  turns: Array<{ role: "user" | "agent"; ts: string; content: string }>;
  suggestedEntry: string | null;
  /** 学习中断唤醒（F6）：恢复会话时的 1 道快问快答，可为 null。 */
  wakeup: WakeupCard | null;
  /** 挂起提问（v2.5）：会话末尾最后一个 ask 行 status=pending 时返回，供输入卡回答态；否则 null。 */
  pendingAsk: AskView | null;
}

export interface ProgressConceptView {
  id: string;
  name: string;
  chapter: string;
  mastery: number;
  evals: number;
  passRate: number;
  ef: number;
  nextReviewAt: string | null;
  misattribution: string;
}

export interface ProgressPayload {
  overallMastery: number;
  dueCount: number;
  lastUpdatedAt: string | null;
  concepts: ProgressConceptView[];
}

export interface MasteryConceptView {
  id: string;
  mastery: number;
  status: "locked" | "learning" | "weak" | "mastered";
}

export interface MasteryChapterView {
  id: string;
  mastery: number;
  concepts: MasteryConceptView[];
}

export interface MasteryPayload {
  chapters: MasteryChapterView[];
}

export interface QuizTaskView {
  taskId: string;
  conceptId: string;
  type: string;
  difficulty: number;
  question: string;
  options: string[] | null;
}

export interface HeatmapDay {
  date: string;
  score: number;
  level: 0 | 1 | 2 | 3;
  tasks: number;
  chatTurns: number;
  weakSpotsCleared: number;
}

export interface HeatmapPayload {
  weeks: number;
  days: HeatmapDay[];
  streak: { current: number; best: number };
}

export interface HeatmapDayDetail {
  date: string;
  changelog: string[];
  events: Array<{ ts: string | null; type: string; taskId: string | null; passed: boolean }>;
}

export interface JobView {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  progress: { total: number; finished: number; currentFile: string | null };
  result: { syllabusVersion: string; tasksGenerated: number } | null;
  error: string | null;
}

export interface ApiErrorPayload {
  error: { code: string; message: string; detail: unknown };
}

export interface SyncResponse {
  added: string[];
  changed: string[];
  skipped: number;
  buildJobId: string;
}
/** 单次工具调用摘要（chat SSE `tool` 事件 / 消息卡工具折叠块，api_spec §3.1 v2.3）。 */
export interface ToolCallView {
  name: string;
  /** "success" | "degraded" | "rejected" */
  status: "success" | "degraded" | "rejected";
  args: Record<string, unknown>;
  summary: string;
  error: string | null;
  durationMs: number;
}

/** 显式提问摘要（chat SSE `ask` 事件 / 消息卡提问块，api_spec §3.1 v2.5）。 */
export interface AskView {
  /** 代理提出的澄清/引导问题文本（绝不携带 rubric/答案）。 */
  question: string;
}


/** chat/stream SSE 事件（api_spec §3.1）。 */
export type ChatEvent =
  | { event: "meta"; data: { sessionId: string; model: string; provider?: string } }
  | { event: "thinking"; data: { delta: string } }
  | { event: "token"; data: { delta: string } }
    | { event: "tool"; data: ToolCallView }
    | { event: "ask"; data: AskView }
  | { event: "sync"; data: Record<string, unknown> }
  | { event: "done"; data: { usage: unknown; turnId: string } }
  | { event: "error"; data: { code: string; message: string } };

/** eval/submit SSE 事件（api_spec §4.2）。 */
export type EvalEvent =
  | { event: "scan"; data: { phase: string } }
  | { event: "rubric"; data: { index: number; criterion: string; hit: boolean } }
  | {
      event: "result";
      data: { score: number; passed: boolean; feedback: string; misconceptions: string[] };
    }
  | {
      event: "sm2";
      data: { ef: number; efNew: number; nextReviewAt: string; masteryDelta: number };
    }
  | { event: "done"; data: { taskId: string } }
  | { event: "error"; data: { code: string; message: string } };
