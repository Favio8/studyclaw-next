/**
 * StudyClaw API 客户端（api_spec v1.5）。
 *
 * - REST：`fetch` + 错误协议统一解析（§1 `{error:{code,message}}`）；
 * - SSE：`POST` + `ReadableStream` 手写解析（EventSource 不支持 POST）。
 * - 全部走相对路径 `/api`（next.config rewrites 代理到后端，规避 CORS）。
 */

import type {
  ApiErrorPayload,
  CourseSummary,
  WakeupCard,
  EvalEvent,
  HeatmapDayDetail,
  HeatmapPayload,
  JobView,
  MasteryPayload,
  ProgressPayload,
  QuizTaskView,
  RestoredSession,
  SessionSummary,
  SessionSearchResponse,
  SyncResponse,
  SettingsPayload,
  ProviderModelPayload,
  ProviderCatalogEntry,
  SessionModelDirectory,
  SessionModelSelection,
  WorkspaceRegistryPayload,
  OpenWorkspaceResponse,
  WorkspaceItem,
  AgentStatusView,
  AgentListPayload,
  ApprovalRequestView,
  AgentProjectionView,
  SessionEventView,
} from "@/src/types/api";
import type { HarnessTask, Syllabus } from "@/src/types";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * FL-30：宿主启动参数（token 等）。两种注入来源：
 * 1. `studyclaw serve` 托管静态 UI 时由 index tap 注入（同源，生产路径）；
 * 2. `next dev` 时由根布局从 host.json 读取注入（开发路径）。
 */
function bootstrapToken(): string | null {
  const boot = (globalThis as unknown as { __STUDYCLAW__?: { token?: unknown } }).__STUDYCLAW__;
  return typeof boot?.token === "string" && boot.token !== "" ? boot.token : null;
}

function authHeaders(): Record<string, string> {
  const token = bootstrapToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * RPC 协议（M1 起）：POST /api/<method>，body `{ payload }`，响应信封
 * `{ ok: true, result } | { ok: false, error: { code, message } }`。
 * 业务错误走信封错误分支（HTTP 200），传输层错误（网络/404/5xx）抛 ApiError。
 */
async function rpc<T>(method: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload === undefined ? {} : { payload }),
    signal,
  });
  let envelope: { ok: boolean; result?: T; error?: { code: string; message: string } };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    throw new ApiError("INTERNAL_ERROR", `HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    throw new ApiError(envelope.error?.code ?? "INTERNAL_ERROR", envelope.error?.message ?? response.statusText, response.status);
  }
  if (!envelope.ok) {
    throw new ApiError(envelope.error?.code ?? "INTERNAL_ERROR", envelope.error?.message ?? "请求失败", 200);
  }
  return envelope.result as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  // UI-25：非 JSON 响应（反向代理错误页等）此前直接抛裸 SyntaxError，
  // 错误信息不可读；统一转 ApiError。
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError("INTERNAL_ERROR", `非 JSON 响应（HTTP ${response.status}）`, response.status);
    }
  }
  if (!response.ok) {
    const payload = body as ApiErrorPayload;
    throw new ApiError(
      payload?.error?.code ?? "INTERNAL_ERROR",
      payload?.error?.message ?? response.statusText,
      response.status,
    );
  }
  return body as T;
}

/** 本地资料上传不能复用 JSON request：浏览器须自行生成 multipart boundary。
 *  W-12：signal 让调用方可取消——大文件上传网络挂起时旧实现 busy 永久 true，
 *  只能刷新页面（无超时/取消的任何入口）。 */
async function uploadFiles<T>(path: string, files: File[], signal?: AbortSignal): Promise<T> {
  const form = new FormData();
  for (const file of files) {
    // 目录选择器会提供相对路径；它能让同名资料在归档后仍可辨识来源。
    form.append("files", file, file.webkitRelativePath || file.name);
  }
  const response = await fetch(path, { method: "POST", headers: { ...authHeaders() }, body: form, signal });
  const text = await response.text();
  // UI-25：同 request——非 JSON 响应转可读的 ApiError。
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError("INTERNAL_ERROR", `非 JSON 响应（HTTP ${response.status}）`, response.status);
    }
  }
  if (!response.ok) {
    const payload = body as ApiErrorPayload;
    throw new ApiError(
      payload?.error?.code ?? "INTERNAL_ERROR",
      payload?.error?.message ?? response.statusText,
      response.status,
    );
  }
  return body as T;
}

/** SSE 帧流解析：`event:` / `data:` / `id:` 行 → 结构化事件。 */
export async function* streamSse<T extends { event: string }>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders(),
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let code = "INTERNAL_ERROR";
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as ApiErrorPayload;
      code = parsed?.error?.code ?? code;
      message = parsed?.error?.message ?? message;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(code, message, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // UI-28：SSE 规范允许 CRLF 行终止；服务端当前输出 LF，这里统一归一化，
    // 防止跨实现（代理/其他宿主）用 \r\n 时帧边界永远匹配不到。
    if (buffer.includes("\r")) buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock<T>(block);
      if (parsed) yield parsed;
      boundary = buffer.indexOf("\n\n");
    }
  }
  const tail = parseSseBlock<T>(buffer);
  if (tail) yield tail;
}

function parseSseBlock<T extends { event: string }>(block: string): T | null {
  const dataLines: string[] = [];
  let event = "";
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    else if (line.startsWith("id: ")) id = line.slice(4).trim();
  }
  if (!event) return null;
  const data = dataLines.length ? JSON.parse(dataLines.join("")) : {};
  return { event, data, ...(id ? { id } : {}) } as unknown as T;
}

// ---------------------------------------------------------------------------
// 端点封装
// ---------------------------------------------------------------------------

export const api = {
  /** FL-22：宿主心跳（GET /api/health）。前端探测失败时展示全屏
   * "后端未启动"横幅，替代旧版三栏空壳零提示的死寂。 */
  health: async (signal?: AbortSignal): Promise<{ ok: boolean }> => {
    const response = await fetch("/api/health", { signal });
    if (!response.ok) throw new ApiError("HOST_UNREACHABLE", `HTTP ${response.status}`, response.status);
    return (await response.json()) as { ok: boolean };
  },

  /** 指定项目的课程列表（M1 起经 RPC workspaces.courses 读取）。 */
  courseList: (path: string) => rpc<{ courses: CourseSummary[]; missing: boolean }>("workspaces.courses", { path }),

  syllabus: (courseId: string) =>
    rpc<Syllabus>("courses.syllabus", { courseId }),

  /** F7 大纲粒度切换（coarse 大章节 / fine 微概念），返回新大纲。 */
  setSyllabusGranularity: (courseId: string, granularity: "fine" | "coarse") =>
    rpc<Syllabus>("courses.syllabusGranularity", { courseId, granularity }),

  progress: (courseId: string) =>
    rpc<ProgressPayload>("courses.progress", { courseId }),

  mastery: (courseId: string) =>
    rpc<MasteryPayload>("courses.mastery", { courseId }),

  /** 对话列表（M2 起经 RPC；mtime 降序 + 轮次计数）。 */
  sessions: (courseId: string) =>
    rpc<{ sessions: SessionSummary[] }>("sessions.list", { courseId }),

  /** Global content search across registered workspaces (dsh session.search parity). */
  searchSessions: (query: string, signal?: AbortSignal) =>
    rpc<SessionSearchResponse>("sessions.search", { query, limit: 50 }, signal),

  /** 新建对话（meta 首行立即落盘）。 */
  newSession: (courseId: string, mode: string, title?: string) =>
    rpc<{ sessionId: string; file: string; wakeup: WakeupCard | null; agentId: string }>(
      "agents.create",
      { courseId, mode, title: title ?? null },
    ).then((result) => ({ ...result, file: "", wakeup: null })),

  /** 恢复对话：历史轮次 + suggestedEntry + pendingAsk。 */
  restoreSession: (courseId: string, sessionId: string) =>
    rpc<RestoredSession>("sessions.restore", { courseId, sessionId }),

  sessionModels: (courseId: string, sessionId: string) =>
    rpc<SessionModelDirectory>("sessions.models", { courseId, sessionId }),

  selectSessionModel: (courseId: string, sessionId: string, selection: SessionModelSelection) =>
    rpc<{ selected: SessionModelSelection }>("sessions.selectModel", { courseId, sessionId, ...selection }),

  createAgent: (courseId: string, mode: string, title?: string | null) =>
    rpc<{ agentId: string; sessionId: string; status: AgentStatusView }>("agents.create", { courseId, mode, title: title ?? null }),
  resumeAgent: (courseId: string, sessionId: string) =>
    rpc<{ agentId: string; sessionId: string; status: AgentStatusView }>("agents.resume", { courseId, sessionId }),
  answerAgent: (agentId: string, answer: string) =>
    rpc<AgentStatusView & { turnId: string }>("agents.answer", { agentId, answer }),
  enqueueAgent: (courseId: string, sessionId: string, mode: string, content: string) =>
    rpc<{ agentId: string; sessionId: string; turnId: string }>("agents.send", { courseId, sessionId, mode, content }),
  agentStatus: (agentId: string) => rpc<AgentStatusView>("agents.status", { agentId }),
  agents: () => rpc<AgentListPayload>("agents.list"),
  cancelAgent: (agentId: string, keepInbox = false) => rpc<AgentStatusView>("agents.cancel", { agentId, keepInbox }),
  /** UI-13：仅清空排队回合，不中止正在运行的回合（QueueDock 取消按钮）。 */
  clearQueuedAgent: (agentId: string) => rpc<{ agentId: string; cleared: number }>("agents.clearQueued", { agentId }),
  agentWhenIdle: (agentId: string) => rpc<AgentStatusView>("agents.whenIdle", { agentId }),
  maintenance: (agentId: string, kind: "checkpoint" | "compaction" = "checkpoint", summary?: string | null) =>
    rpc<{ jobId: string; agentId: string; kind: "checkpoint" | "compaction"; status: "queued" | "running" | "done" | "failed" }>("agents.maintenance", { agentId, kind, summary: summary ?? null }),
  maintenanceJobs: (agentId: string) => rpc<{ jobs: AgentProjectionView["maintenanceJobs"] }>("agents.maintenanceJobs", { agentId }),
  disposeAgent: (agentId: string) => rpc<AgentStatusView>("agents.dispose", { agentId }),
  approvals: (agentId?: string) => rpc<{ items: ApprovalRequestView[] }>("approvals.list", agentId ? { agentId } : {}),
  resolveApproval: (requestId: string, decision: "allow" | "deny" | "cancel") =>
    rpc<ApprovalRequestView>("approvals.resolve", { requestId, decision }),
  agentProjection: (agentId: string) => rpc<AgentProjectionView>("agents.projection", { agentId }),
  sessionEvents: (courseId: string, sessionId: string, afterSeq = 0) =>
    rpc<{ events: SessionEventView[]; lastSeq: number }>("sessions.events", { courseId, sessionId, afterSeq }),
  plan: (agentId: string) => rpc<{ steps: AgentProjectionView["plan"]["steps"]; updatedAt: string | null }>("plans.get", { agentId }),
  todos: (agentId: string) => rpc<{ items: AgentProjectionView["todos"] }>("todos.get", { agentId }),
  updatePlan: (agentId: string, steps: Array<Record<string, unknown>>) => rpc<{ steps: AgentProjectionView["plan"]["steps"] }>("plans.update", { agentId, steps }),
  updateTodos: (agentId: string, items: Array<Record<string, unknown>>) => rpc<{ items: AgentProjectionView["todos"] }>("todos.update", { agentId, items }),

  /** Rename a persisted session (metadata line only). */
  renameSession: (courseId: string, sessionId: string, title: string) =>
    rpc<{ sessionId: string; title: string }>("sessions.rename", { courseId, sessionId, title }),

  /** Fork a session and return the new session id. */
  forkSession: (courseId: string, sessionId: string, chatIndex?: number) =>
    rpc<{ sessionId: string; file: string }>("sessions.fork", {
      courseId,
      sessionId,
      ...(chatIndex === undefined ? {} : { chatIndex }),
    }),

  /** Archive a session without removing its durable JSONL history. */
  archiveSession: (courseId: string, sessionId: string) =>
    rpc<{ sessionId: string; archived: true }>("sessions.archive", { courseId, sessionId }),

  /** Persist the manual order by inserting a session before another one. */
  reorderSession: (courseId: string, sessionId: string, beforeId?: string) =>
    rpc<{ sessions: SessionSummary[] }>("sessions.reorder", { courseId, sessionId, beforeId }),

  quiz: (courseId: string, mode: "review" | "new", count = 5, dueOnly = false) =>
    rpc<{ tasks: QuizTaskView[] }>("courses.quiz", { courseId, mode, count, ...(dueOnly ? { dueOnly } : {}) }),

  heatmap: (weeks = 12) =>
    rpc<HeatmapPayload>("metrics.heatmap", { weeks }),

  heatmapDay: (date: string) =>
    rpc<HeatmapDayDetail>("metrics.heatmapDay", { date }),

  job: (jobId: string) => rpc<JobView>("jobs.get", { jobId }),

  /** 设置（M2 起经 RPC settings.get；默认模式来自 config.yaml）。 */
  settings: () => rpc<SettingsPayload>("settings.get"),

  /** 部分更新语义（api_spec §2.6 v2.6）：只发送出现的字段。 */
  updateSettings: (payload: {
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
    apiBase?: string | null;
    temperature?: number;
    maxConcurrency?: number;
    defaultMode?: SettingsPayload["ui"]["defaultMode"];
    agentPreset?: string;
    permissionPreset?: string;
    plugins?: Record<string, boolean>;
  }) => rpc<SettingsPayload>("settings.update", payload),

  /** 内置供应商目录（api_spec §2.8 v2.6；静态声明，不含密钥）。 */
  providerCatalog: () =>
    rpc<{ catalog: ProviderCatalogEntry[] }>("settings.providerCatalog"),

  /** 向端点代理询问模型列表；只读探测，不落盘（api_spec §2.8 v2.6）。 */
  discoverModels: (payload: { baseUrl: string; apiKey?: string; apiKeyEnv?: string }) =>
    rpc<{ models: ProviderModelPayload[] }>("settings.discoverModels", payload),

  /** 项目根候选资料枚举（api_spec §6.3，新项目向导勾选数据源）。 */
  workspaceFiles: () =>
    rpc<{
      root: string;
      files: Array<{
        name: string;
        path: string;
        relative: string;
        size: number;
        mtime: string;
        supported: boolean;
      }>;
    }>("workspace.files"),

  /** 当前课程资料枚举，用于输入框的 @ 文件引用。 */
  courseFiles: (courseId: string) =>
    rpc<{
      root: string;
      files: Array<{
        name: string;
        path: string;
        relative: string;
        size: number;
        mtime: string;
        supported: boolean;
      }>;
    }>("courses.files", { courseId }),

  /** 空骨架自愈（无 LLM）：课程记录缺失时就地补一份，随后新对话即可用。 */
  ensureCourse: (courseId: string) =>
    rpc<{ ensured: boolean }>("courses.ensure", { courseId }),

  sync: (courseId: string, sessionId?: string | null) =>
    rpc<SyncResponse>("courses.sync", { courseId, sessionId }),

  /** 提交作答并流式接收判定（SSE 六帧：scan/rubric×N/result/sm2/done）。
   * UI-7：evalId 为幂等键（taskId+会话+作答内容的稳定指纹）——网络中断后
   * 用同一键重试，服务端直接重放已结算帧，不重复 settle 计分。 */
  evalSubmit: (
    courseId: string,
    taskId: string,
    answer: string,
    sessionId?: string | null,
    signal?: AbortSignal,
    evalId?: string | null,
  ) =>
    streamSse<EvalEvent>(
      "/api/eval/submit",
      { courseId, taskId, answer, sessionId, ...(evalId ? { evalId } : {}) },
      undefined,
      signal,
    ),

  initWorkspace: (payload: {
    mode: "create" | "inplace";
    courseName?: string;
    importPaths?: string[];
    targetDir?: string;
    deferBuild?: boolean;
  }) =>
    payload.mode === "create"
      ? rpc<{
          workspace: string;
          course: string;
          ingestedFiles: number;
          buildJobId: string | null;
        }>("workspaces.createCourse", { courseName: payload.courseName ?? "新课程", importPaths: payload.importPaths ?? [] })
      : Promise.reject(new ApiError("NOT_IMPLEMENTED", "inplace 模式暂未接线（使用添加项目）", 200)),

  /** 宿主系统目录选择框（Windows: PowerShell FolderBrowserDialog）。 */
  pickWorkspaceDirectory: () => rpc<{ path: string | null }>("host.pickDirectory"),

  /** 服务端目录浏览（DSH browse 后端）：一次一页的快速 RPC，无原生对话框依赖。 */
  browseDirectory: (path: string | null) =>
    rpc<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(
      "host.browseDirectory",
      { path },
    ),

  /** 幂等接管一个本地项目（同路径重复打开返回已有记录，created=false）。 */
  openWorkspace: (path: string) =>
    rpc<OpenWorkspaceResponse>("workspaces.open", { path }),

  /** 项目注册表（当前指针 + 有序列表，左栏并列树的唯一数据源）。 */
  workspaces: () => rpc<WorkspaceRegistryPayload>("workspaces.list"),

  /** 从注册表移除项目（只忘记录，不动磁盘数据）。 */
  removeWorkspace: (id: string) =>
    rpc<{ items: WorkspaceItem[] }>("workspaces.remove", { id }),

  /** 重命名项目；与其他项目重名时后端返回 workspace-name-conflict。 */
  renameWorkspace: (id: string, title: string) =>
    rpc<{ workspace: WorkspaceItem }>("workspaces.rename", { id, title }),

  /** 拖拽排序：把 id 插到 beforeId 之前（省略 beforeId = 移到末尾）。 */
  reorderWorkspace: (id: string, beforeId?: string) =>
    rpc<{ items: WorkspaceItem[] }>("workspaces.reorder", { id, beforeId }),

  /** 只读列出某项目的课程（目录已删时 missing=true）。 */
  workspaceCourses: (path: string) =>
    rpc<{ courses: CourseSummary[]; missing: boolean }>("workspaces.courses", { path }),

  /** FL-19：buildJobId 可为 null（未配置模型不启动构建）；FL-12：消费
   * rejected（超限/落盘失败清单）与 buildError（构建失败原因）。
   *  W-12：signal 供调用方取消（弹窗关闭/切项目时中止在途上传）。 */
  uploadSources: (courseId: string, files: File[], signal?: AbortSignal) =>
    uploadFiles<{
      added: string[];
      buildJobId: string | null;
      buildError?: string;
      rejected?: Array<{ file: string; reason: string }>;
    }>(
      `/api/courses/${courseId}/sources`,
      files,
      signal,
    ),

  /** 网页链接 Ingest（api_spec §6.7）：URL -> 正文入 sources -> 增量构建。 */
  ingestUrl: (courseId: string, url: string, title?: string) =>
    rpc<{ courseId: string; added: string; url: string; buildJobId: string | null }>(
      "courses.ingestUrl",
      { courseId, url, title: title ?? null },
    ),

  /** 对话即出题（api_spec §6.5）：把划选段落转成合规复习卡入池。 */
  createCard: (
    courseId: string,
    payload: { content: string; title?: string; conceptId?: string; count?: number },
  ) =>
    rpc<{ courseId: string; tasks: HarnessTask[] }>("courses.cards", { courseId, ...payload }),
  saveProvider: (payload: {
    id: string;
    name: string;
    model: string;
    baseUrl: string | null;
    /** 缺省 = 保留现值（merge 语义，DSH 对齐）。 */
    temperature?: number;
    maxConcurrency?: number;
    /** null = 保留现有列表；[] = 清空；数组 = 整体替换。 */
    models?: { id: string; name: string; contextWindow: number | null; maxTokens: number | null }[] | null;
    /** 创建时覆盖已存在 id 需要显式置 true（否则 409 provider-exists）。 */
    overwrite?: boolean;
  }) => rpc<SettingsPayload>("settings.saveProvider", payload),

  setProviderCredential: (providerId: string, apiKey: string) =>
    rpc<SettingsPayload>("settings.setCredential", { providerId, apiKey }),

  deleteProvider: (providerId: string) =>
    rpc<SettingsPayload>("settings.deleteProvider", { providerId }),

  activateProvider: (providerId: string) =>
    rpc<SettingsPayload>("settings.activateProvider", { providerId }),
};
