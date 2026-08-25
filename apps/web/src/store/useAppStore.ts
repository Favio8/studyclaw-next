/**
 * StudyClaw WebUI 全局状态（Zustand，T3.1）。
 *
 * 三栏共享：激活项目/对话、当前学习模式、右栏 Tab 与新事件角标、
 * 中栏聚焦概念（大纲树/拓扑图点击 → Agent 注入对应 chunk 上下文）、
 * 同步指示灯（● Synced / ◌ Syncing）。
 */

import { create } from "zustand";
import type {
  CourseSummary,
  HeatmapPayload,
  MasteryPayload,
  ProgressPayload,
  QuizTaskView,
  SessionSummary,
    ToolCallView,
  AskView,
  WakeupCard,
} from "@/src/types/api";
import type { LearningMode } from "@/src/types";

export type PanelTab = "progress" | "syllabus" | "heatmap" | "quiz";

// ---------------------------------------------------------------------------
// Quiz（🎯 题卡 Tab）状态：驱动与 SSE 编排在 lib/quizFlow.ts（store 保持纯同步）
// ---------------------------------------------------------------------------

export interface QuizRubricItem {
  index: number;
  criterion: string;
  hit: boolean;
}

export interface QuizResult {
  score: number;
  passed: boolean;
  feedback: string;
  misconceptions: string[];
}

export interface QuizSm2 {
  ef: number;
  efNew: number;
  nextReviewAt: string;
  masteryDelta: number;
}

export type QuizPhase = "idle" | "answering" | "scanning" | "evaluating" | "done";

export interface QuizState {
  mode: "review" | "new";
  tasks: QuizTaskView[];
  index: number;
  phase: QuizPhase;
  rubrics: QuizRubricItem[];
  result: QuizResult | null;
  sm2: QuizSm2 | null;
  error: string | null;
  loading: boolean;
  /** 最后一题的作答文本（失败重试用）。 */
  lastAnswer: string | null;
  /** 简答题输入缓冲（组件直接读写，避免 effect 竞态）。 */
  answerText: string;
}

export const initialQuiz: QuizState = {
  mode: "review",
  tasks: [],
  index: 0,
  phase: "idle",
  rubrics: [],
  result: null,
  sm2: null,
  error: null,
  loading: false,
  lastAnswer: null,
  answerText: "",
};

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  /** 消息产生时间（ISO），用于消息 hover 时钟。 */
  createdAt?: string;
  /** 思考链（agent 专用；折叠块头部显示耗时）。 */
  thinking?: string;
  thinkingMs?: number;
  mode?: string;
  streaming?: boolean;
  /** 工具调用审计（agent 专用；折叠展示，不渲染进正文）。 */
  tools?: ToolCallView[];
  /** M-C (Sprint 8): explicit ask from the agent, shown as AskFold. */
  ask?: AskView;
  /** 流式失败/服务端 error 事件：消息卡尾部渲染错误行 + 重试键。 */
  error?: string;
  /** 客户端本地命令回显不属于 JSONL 聊天历史，不能作为分支锚点。 */
  persisted?: boolean;
}

interface AppState {
  // -- 项目与对话（左栏） ------------------------------------------------------
  courses: CourseSummary[];
  activeCourseId: string | null;
  /** 已加载项目的对话树；左栏不能把当前项目的对话投影到其他项目下。 */
  courseSessions: Record<string, SessionSummary[]>;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  activeSessionTitle: string;

  // -- 对话（中栏） --------------------------------------------------------------
  messages: ChatMessage[];
  streaming: boolean;
  syncState: "synced" | "syncing";
  /** 课程知识索引构建状态，和聊天同步状态分开显示。 */
  buildStatus: "idle" | "running" | "done" | "failed";
  mode: LearningMode;
  focusConceptId: string | null;
  modeBanner: string | null; // 模式/状态切换横幅（1.6s 后自动消失）
  sessionBanner: string | null; // 对话横幅（常驻，切换时闪现）
  suggestedEntry: string | null; // 恢复对话的建议入口（可点击发送）
  lastTurnId: string | null; // 最近完成轮次 id（断线 Last-Event-ID 重连用）
  /** 学习中断唤醒（F6）：恢复/新建对话时的 1 道快问快答，可跳过。 */
  wakeupCard: WakeupCard | null;
  /** M-C (Sprint 8): pending ask question for composer answer state. */
  pendingAsk: AskView | null;
  /** 当前生效的模型座位（chat meta 帧 / 模型座位切换写入，api_spec §3.1 v2.6）。 */
  activeModel: { providerId: string; model: string; effort?: string | null } | null;
  /** 当前活动项目根目录（/api/workspaces 的 current；切换器显示用）。 */
  workspacePath: string | null;
  /** dsh InputMachine 语义：未发送草稿按项目/课程/对话隔离，切回时恢复。 */
  composerDrafts: Record<string, string>;

  // -- 右栏面板 --------------------------------------------------------------------
  activeTab: PanelTab;
  badges: Record<PanelTab, boolean>;
  progress: ProgressPayload | null;
  mastery: MasteryPayload | null;
  heatmap: HeatmapPayload | null;
  quiz: QuizState;
  /** 大纲树折叠状态（key=章节 id）；入 store 跨视图/重挂保持。 */
  syllabusCollapsed: Record<string, boolean>;
  /** 大纲树搜索词（入 store，切视图不丢）。 */
  syllabusSearch: string;

  // -- 全局弹层 ----------------------------------------------------------------------
  paletteOpen: boolean;
  wizardOpen: boolean;
  settingsOpen: boolean;

  // -- actions -----------------------------------------------------------------------
  setCourses: (courses: CourseSummary[]) => void;
  setActiveCourse: (courseId: string | null) => void;
  setCourseSessions: (courseId: string, sessions: SessionSummary[]) => void;
  setSessions: (sessions: SessionSummary[]) => void;
  setActiveSession: (sessionId: string | null, title?: string) => void;
  setMessages: (messages: ChatMessage[]) => void;
  appendMessage: (message: ChatMessage) => void;
  updateMessage: (messageId: string, patch: Partial<ChatMessage>) => void;
  updateLastAgent: (patch: Partial<ChatMessage>) => void;
  setStreaming: (streaming: boolean) => void;
  setSyncState: (state: "synced" | "syncing") => void;
  setBuildStatus: (state: "idle" | "running" | "done" | "failed") => void;
  setMode: (mode: LearningMode) => void;
  setFocusConcept: (conceptId: string | null) => void;
  flashModeBanner: (text: string) => void;
  flashStatusBanner: (text: string) => void;
  setSessionBanner: (text: string | null) => void;
  setSuggestedEntry: (text: string | null) => void;
  setLastTurnId: (turnId: string | null) => void;
  setWakeupCard: (card: WakeupCard | null) => void;
  setPendingAsk: (ask: AskView | null) => void;
  setActiveModel: (active: { providerId: string; model: string; effort?: string | null } | null) => void;
  setWorkspacePath: (path: string | null) => void;
  setComposerDraft: (key: string, draft: string) => void;
  setActiveTab: (tab: PanelTab) => void;
  toggleBadge: (tab: PanelTab, on: boolean) => void;
  setPanelData: (patch: Partial<Pick<AppState, "progress" | "mastery" | "heatmap">>) => void;
  setSyllabusCollapsed: (chapterId: string, collapsed: boolean) => void;
  setSyllabusSearch: (search: string) => void;
  setQuiz: (patch: Partial<QuizState>) => void;
  quizReset: () => void;
  setPaletteOpen: (open: boolean) => void;
  setWizardOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  resetCourseScoped: () => void;
}

let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let msgSeq = 0;
export function nextMessageId(): string {
  msgSeq += 1;
  return `m_${Date.now().toString(36)}_${msgSeq}`;
}

export const useAppStore = create<AppState>((set) => ({
  courses: [],
  activeCourseId: null,
  courseSessions: {},
  sessions: [],
  activeSessionId: null,
  activeSessionTitle: "",
  sessionBanner: null,
  suggestedEntry: null,
  lastTurnId: null,
  wakeupCard: null,
  pendingAsk: null,
  activeModel: null,
  workspacePath: null,
  composerDrafts: {},
  messages: [],
  streaming: false,
  syncState: "synced",
  buildStatus: "idle",
  mode: "socratic",
  focusConceptId: null,
  modeBanner: null,
  activeTab: "progress",
  badges: { progress: false, syllabus: false, heatmap: false, quiz: false },
  progress: null,
  mastery: null,
  heatmap: null,
  quiz: { ...initialQuiz },
  syllabusCollapsed: {},
  syllabusSearch: "",
  paletteOpen: false,
  wizardOpen: false,
  settingsOpen: false,

  setCourses: (courses) => set({ courses }),
  setActiveCourse: (courseId) =>
    set((state) => ({
      activeCourseId: courseId,
      // 切换项目：右栏数据全量刷新（数据体置空触发骨架屏，§4.4）
      sessions: [],
      activeSessionId: null,
      activeSessionTitle: "",
      activeModel: null,
      messages: [],
      progress: null,
      mastery: null,
      heatmap: null,
      quiz: { ...initialQuiz },
      syllabusCollapsed: {},
      syllabusSearch: "",
      focusConceptId: null,
      buildStatus: "idle",
      wakeupCard: null,
  pendingAsk: null,
      badges: state.badges,
    })),
  setCourseSessions: (courseId, sessions) =>
    set((state) => ({
      courseSessions: { ...state.courseSessions, [courseId]: sessions },
    })),
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (sessionId, title = "") =>
    // 仅更新 id/标题；消息列表由调用方显式控制（恢复渲染/清空/流式 meta 均需区分）
    set({ activeSessionId: sessionId, activeSessionTitle: title, activeModel: null }),
  setMessages: (messages) => set({ messages }),
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, ...patch } : message,
      ),
    })),
  updateLastAgent: (patch) =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "agent") {
          messages[i] = { ...messages[i], ...patch };
          break;
        }
      }
      return { messages };
    }),
  setStreaming: (streaming) => set({ streaming }),
  setSyncState: (syncState) => set({ syncState }),
  setBuildStatus: (buildStatus) => set({ buildStatus }),
  setMode: (mode) => set({ mode }),
  setFocusConcept: (focusConceptId) => set({ focusConceptId }),
  flashModeBanner: (text) => {
    set({ modeBanner: text });
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => set({ modeBanner: null }), 1600);
  },
  flashStatusBanner: (text) => {
    // 状态横幅与模式横幅共用同一机制（1.6s 后自动消失）
    set({ modeBanner: text });
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => set({ modeBanner: null }), 1600);
  },
  setSessionBanner: (sessionBanner) => set({ sessionBanner }),
  setSuggestedEntry: (suggestedEntry) => set({ suggestedEntry }),
  setLastTurnId: (lastTurnId) => set({ lastTurnId }),
  setWakeupCard: (wakeupCard) => set({ wakeupCard }),
  setPendingAsk: (pendingAsk) => set({ pendingAsk }),
  setActiveModel: (activeModel) => set({ activeModel }),
  setWorkspacePath: (workspacePath) => set({ workspacePath }),
  setComposerDraft: (key, draft) =>
    set((state) => {
      const current = state.composerDrafts[key];
      if (current === draft || (current === undefined && draft === "")) return state;
      if (draft === "") {
        const { [key]: _removed, ...composerDrafts } = state.composerDrafts;
        return { composerDrafts };
      }
      return { composerDrafts: { ...state.composerDrafts, [key]: draft } };
    }),
  setActiveTab: (tab) =>
    set((state) => ({
      activeTab: tab,
      badges: { ...state.badges, [tab]: false }, // 查看即清除角标
    })),
  toggleBadge: (tab, on) =>
    set((state) => ({ badges: { ...state.badges, [tab]: on } })),
  setPanelData: (patch) => set(patch),
  setSyllabusCollapsed: (chapterId, collapsed) =>
    set((state) => ({ syllabusCollapsed: { ...state.syllabusCollapsed, [chapterId]: collapsed } })),
  setSyllabusSearch: (syllabusSearch) => set({ syllabusSearch }),
  setQuiz: (patch) =>
    set((state) => ({ quiz: { ...state.quiz, ...patch } })),
  quizReset: () => set({ quiz: { ...initialQuiz } }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  resetCourseScoped: () =>
    set({
      sessions: [],
      activeSessionId: null,
      activeSessionTitle: "",
      sessionBanner: null,
      suggestedEntry: null,
      lastTurnId: null,
      wakeupCard: null,
  pendingAsk: null,
      messages: [],
      progress: null,
      mastery: null,
      heatmap: null,
      quiz: { ...initialQuiz },
      syllabusCollapsed: {},
      syllabusSearch: "",
      buildStatus: "idle",
    }),
}));
