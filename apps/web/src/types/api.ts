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
  reasoningEfforts?: Array<{ id: string; name: string; description?: string }>;
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
  agent: { preset: string; presets: Array<{ id: string; name: string; description: string }> };
  permissions: { preset: string; presets: Array<{ id: string; name: string; sandboxMode: "read-only" | "workspace-write" | "danger-full-access"; approvalPolicy: "deny" | "ask" | "never"; description: string }> };
  plugins: { inventory: Array<{ id: string; name: string; enabled: boolean; source: "builtin" | "workspace"; reason?: string }> };
}

/** 项目注册表条目（dsh 语义：uuid 键 + canonical 路径，持久化于宿主）。 */
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

/** 打开/接管一个本地项目的响应（M1：course/session 字段在 M2/M3 回归）。 */
export interface OpenWorkspaceResponse {
  workspace: WorkspaceItem;
  created: boolean;
  /** FL-18：自动建课骨架失败的原因（缺省 = 无警告）。 */
  courseWarning?: string | null;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  mode: string;
  turns: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionModelSelection {
  provider: string;
  model: string;
  effort?: string | null;
}

export interface SessionModelEffort {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModelEntry {
  id: string;
  name: string;
  efforts?: SessionModelEffort[];
}

export interface SessionModelGroup {
  id: string;
  name: string;
  models: SessionModelEntry[];
}

export interface SessionModelDirectory {
  current: SessionModelSelection | null;
  routable: boolean;
  groups: SessionModelGroup[];
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface AgentStatusView {
  agentId: string;
  sessionId: string;
  parentAgentId: string | null;
  phase: "idle" | "queued" | "running" | "waiting" | "cancelled" | "disposed";
  queued: number;
  activeTurnId: string | null;
  cwd: string;
  capabilities: Array<{ id: string; available: boolean; reason: string | null; installAction: string | null }>;
  modelSelection: SessionModelSelection | null;
  preset: string;
}

export interface AgentListPayload {
  agents: AgentStatusView[];
}

export interface ApprovalRequestView {
  id: string;
  agentId: string;
  sessionId: string;
  name: string;
  policy: string;
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "allow" | "deny" | "cancel" | "timeout";
}

export interface SessionEventView {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AgentProjectionView {
  sessionId: string;
  phase: "idle" | "queued" | "running" | "waiting" | "cancelled" | "disposed";
  currentModel: SessionModelSelection | null;
  modelProvenance: { provider: string; model: string; effort: string | null; requestId: string | null };
  agentConfig: { agentPreset: string; permissionPreset: "read-only" | "workspace-write" | "danger-full-access"; plugins: Record<string, boolean> } | null;
  agentRuntime: { agentId: string; sessionId: string; cwd: string; preset: Record<string, unknown>; permissionPreset: "read-only" | "workspace-write" | "danger-full-access"; capabilities: Array<{ id: string; available: boolean; reason: string | null; installAction: string | null }>; systemPrompt: string } | null;
  messages: Array<{ role: "user" | "assistant"; content: string; seq: number }>;
  tools: Array<{ callId: string; name: string; status: string; summary: string; args: Record<string, unknown>; error: string | null; parentCallId?: string | null; seq: number }>;
  pendingAsk: string | null;
  pendingApprovals: Array<{ requestId: string; name: string; policy: string; args: Record<string, unknown>; seq: number }>;
  plan: { steps: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>; updatedAt: string | null };
  todos: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; provider: string | null; model: string | null };
  cancellation: { reason: string; ts: string } | null;
  maintenance: { running: boolean; kind: string | null; lastAt: string | null };
  maintenanceJobs: Array<{
    jobId: string;
    agentId: string;
    kind: "checkpoint" | "compaction";
    status: "queued" | "running" | "done" | "failed";
    summary: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  compaction: { count: number; lastSeq: number | null; summary: string | null };
  lineage: { parentSessionId: string | null; forkSeq: number | null };
  children: Array<{ agentId: string; sessionId: string; seq: number }>;
  lastSeq: number;
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
  /** 学习中断唤醒（F6）：恢复对话时的 1 道快问快答，可为 null。 */
  wakeup: WakeupCard | null;
  /** 挂起提问（v2.5）：对话末尾最后一个 ask 行 status=pending 时返回，供输入卡回答态；否则 null。 */
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
  /** MCQ 答案键（0 起始）；旧卡为 null → 服务端 rubric 判分。 */
  answerIndex: number | null;
  answerRationale: string | null;
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
  /** FL-05：degraded 摘要（抽取失败/零概念块/差卡被闸）随 job 结果透出。 */
  result: { syllabusVersion: string; tasksGenerated: number; degraded?: string[] } | null;
  error: string | null;
}

export interface ApiErrorPayload {
  error: { code: string; message: string; detail: unknown };
}

export interface SyncResponse {
  added: string[];
  changed: string[];
  skipped: number;
  /** 无可用模型时后端不启动 job，可能为 null（FL-19 类型对齐）。 */
  buildJobId: string | null;
}
/** 单次工具调用摘要（chat SSE `tool` / `tool-start` 事件）。 */
export interface ToolCallView {
  /** Stable call id used to settle a running row. */
  callId?: string;
  /** Parent call for nested workflow/subagent tool trees. */
  parentCallId?: string | null;
  name: string;
  /** running is UI-only; persisted tool rows use the three terminal states. */
  status: "running" | "success" | "degraded" | "rejected";
  args: Record<string, unknown>;
  summary: string;
  error: string | null;
  durationMs: number | null;
}

/** 显式提问摘要（chat SSE `ask` 事件 / 消息卡提问块，api_spec §3.1 v2.5）。 */
export interface AskView {
  /** 代理提出的澄清/引导问题文本（绝不携带 rubric/答案）。 */
  question: string;
}


/** chat/stream SSE 事件（api_spec §3.1）。 */
export type ChatEvent =
  | { event: "meta"; data: { sessionId: string; model: string; provider?: string; effort?: string | null } }
  | { event: "thinking"; data: { delta: string } }
  | { event: "token"; data: { delta: string } }
  | { event: "tool-start"; data: { callId: string; name: string; args: Record<string, unknown> } }
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
  /** FL-09：服务端非阻断告警帧（如 AUDIT_WRITE_FAILED），评分流程继续。 */
  | { event: "warning"; data: { code: string; message: string } }
  | { event: "error"; data: { code: string; message: string } };
