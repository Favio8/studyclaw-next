/**
 * 「今天」视图回归：
 * - 有到期卡时仍是「一个大数字 + 唯一主按钮」（保留"一屏决定"的克制）；
 * - 没有到期卡时不再是一句空话：用真实数据给出可执行清单、该练的概念、近 7 天与继续上次；
 * - 名言卡片在最上方；每个模块有数据才出现。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const quizLoad = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quizFlow", () => ({ quizLoad }));

const sessionActions = vi.hoisted(() => ({ selectSession: vi.fn(), createSession: vi.fn(async () => true) }));
vi.mock("../src/hooks/useSessionActions", () => ({ useSessionActions: () => sessionActions }));

const storeState = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩按场景改写状态
  const state: any = {
    digest: null,
    progress: null,
    heatmap: { streak: { current: 0, best: 0 }, weeks: 12, days: [] },
    conceptCardStatus: null,
    courses: [],
    courseSessions: {},
    sessions: [],
    activeCourseId: null,
    activeSessionId: null,
    courseDataRevision: 0,
    lastImport: null,
    onboardingHidden: false,
    settingsSection: "general",
    setCenterView: vi.fn(),
    setActiveTab: vi.fn(),
    setRightPanelCollapsed: vi.fn(),
    setFocusConcept: vi.fn(),
    setOnboardingHidden: vi.fn(),
    setWizardOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
    setSettingsSection: vi.fn(),
    setConceptCardStatus: vi.fn(),
    setConceptFill: vi.fn(),
    flashStatusBanner: vi.fn(),
  };
  return state;
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

vi.mock("../src/lib/api", () => ({
  api: {
    settings: vi.fn(async () => ({
      activeProviderId: "",
      llm: { provider: "", model: "", apiBase: null, apiKeyConfigured: false },
      ui: { defaultMode: "socratic" },
      providers: [],
    })),
    courseFiles: vi.fn(async () => ({ files: [] })),
    conceptCardStatus: vi.fn(async () => ({
      modelReady: true, conceptOrigin: "semantic", totalConcepts: 3,
      coveredConcepts: 3, missingConcepts: 0, missing: [], concepts: [],
    })),
  },
}));

import TodayView from "../src/components/center/TodayView";

function concept(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: `概念${id}`, chapter: "章一", mastery: 0.2, evals: 0, passRate: 0,
    nextReviewAt: null, exposure: 0, taskCount: 0, annotationCount: 0, lastAnnotatedAt: null,
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.digest = null;
  storeState.progress = null;
  storeState.heatmap = { streak: { current: 0, best: 0 }, weeks: 12, days: [] };
  storeState.conceptCardStatus = null;
  storeState.courseSessions = {};
  storeState.sessions = [];
  storeState.activeCourseId = null;
  storeState.onboardingHidden = true; // 默认隐藏引导卡，聚焦「今天」模块本身
});

it("首次打开静态页面时浏览器存储不造成 hydration 错位", async () => {
  window.localStorage.clear();
  storeState.onboardingHidden = false;
  const browserWindow = window;
  let html: string;
  vi.stubGlobal("window", undefined);
  try { html = renderToString(<TodayView />); } finally { vi.stubGlobal("window", browserWindow); }
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const recoveries: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, <TodayView />, { onRecoverableError: (error) => recoveries.push(error) });
    });
    expect(recoveries).toEqual([]);
    expect(container.textContent).toContain("开始你的第一门课程");
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

describe("TodayView 今天", () => {
  it("名言卡片始终在最上方", () => {
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    render(<TodayView />);
    expect(screen.getByTestId("today-quote")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "换一句" })).toBeInTheDocument();
  });

  it("有到期卡：一个大数字 + 唯一主按钮，点击直达复习", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 12, concepts: [], recentHighlights: 0 };
    render(<TodayView />);

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("张卡片到期复习")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开始复习/ }));
    expect(storeState.setCenterView).toHaveBeenCalledWith("chat");
    expect(storeState.setActiveTab).toHaveBeenCalledWith("quiz");
    expect(quizLoad).toHaveBeenCalledWith("review");
    expect(storeState.setRightPanelCollapsed).toHaveBeenCalledWith(false);
  });

  it("没有到期但有关注点：清单给出可执行动作（回顾原文）", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 3 };
    render(<TodayView />);

    expect(screen.queryByText("张卡片到期复习")).toBeNull();
    expect(screen.getByText(/近 24 小时划了 3 条重点/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回顾原文" }));
    expect(storeState.setCenterView).toHaveBeenCalledWith("reading");
  });

  it("缺题概念进入清单，点击补齐题卡", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    storeState.conceptCardStatus = { modelReady: true, conceptOrigin: "semantic", totalConcepts: 8, coveredConcepts: 5, missingConcepts: 3, missing: [], concepts: [] };
    render(<TodayView />);

    expect(screen.getByText(/还有 3 个概念没有题卡/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "补齐题卡" }));
    expect(storeState.setActiveTab).toHaveBeenCalledWith("progress");
    expect(storeState.setRightPanelCollapsed).toHaveBeenCalledWith(false);
  });

  it("既无到期也无关注点：给出三个可执行建议而不是空话", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    storeState.progress = { overallMastery: 0, dueCount: 0, lastUpdatedAt: null, concepts: [concept("a")] };
    render(<TodayView />);

    expect(screen.getByText(/今天没有到期的复习/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /随机练一组题/ }));
    expect(quizLoad).toHaveBeenCalledWith("new");
  });

  it("该练的概念：到期在前、薄弱在后，点「练它」带 conceptId 出题", () => {
    storeState.activeCourseId = "course-1";
    const today = new Date();
    const due = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    storeState.digest = {
      dueCount: 1,
      recentHighlights: 0,
      concepts: [
        concept("due", { name: "显式记忆", mastery: 0.5, evals: 2, nextReviewAt: due }),
        concept("weak", { name: "记忆更新", mastery: 0.25, evals: 1 }),
      ],
    };
    render(<TodayView />);

    expect(screen.getByText("显式记忆")).toBeInTheDocument();
    expect(screen.getByText("记忆更新")).toBeInTheDocument();
    expect(screen.getAllByText(/^到期/)).toHaveLength(1);
    expect(screen.getAllByText("薄弱")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "练它" })[1]!);
    expect(storeState.setFocusConcept).toHaveBeenCalledWith("weak");
    expect(quizLoad).toHaveBeenCalledWith("new", false, "weak");
  });

  it("从未测过的概念也进入该练清单（标记未测），避免页面留白", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = {
      dueCount: 0,
      recentHighlights: 0,
      concepts: [concept("fresh", { name: "未测概念", evals: 0, exposure: 0 })],
    };
    render(<TodayView />);

    expect(screen.getByText("未测概念")).toBeInTheDocument();
    expect(screen.getByText("未测")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "练它" }));
    expect(quizLoad).toHaveBeenCalledWith("new", false, "fresh");
  });

  it("资料卡显示可阅读资料数并提供入口", async () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    const { api } = await import("../src/lib/api");
    vi.mocked(api.courseFiles).mockResolvedValue({
      root: "/tmp", files: [
        { name: "a.pdf", path: "/tmp/a.pdf", relative: "a.pdf", size: 1, mtime: "", supported: true },
        { name: "b.docx", path: "/tmp/b.docx", relative: "b.docx", size: 1, mtime: "", supported: true },
        { name: "c.bin", path: "/tmp/c.bin", relative: "c.bin", size: 1, mtime: "", supported: false },
      ],
    });
    render(<TodayView />);
    expect(await screen.findByText("2 份资料可阅读")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去阅读" })).toBeInTheDocument();
  });

  it("近 7 天与连续天数、继续上次都从真实数据渲染", () => {
    storeState.activeCourseId = "course-1";
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    storeState.heatmap = {
      streak: { current: 1, best: 2 },
      weeks: 12,
      days: [
        { date: "2026-10-11", score: 0, level: 0, tasks: 0, chatTurns: 0, weakSpotsCleared: 0 },
        { date: "2026-10-12", score: 3, level: 2, tasks: 3, chatTurns: 1, weakSpotsCleared: 0 },
      ],
    };
    storeState.courseSessions = {
      "course-1": [{ sessionId: "s1", title: "LLM记忆三轴分类", mode: "socratic", turns: 4, createdAt: "", lastActiveAt: new Date(Date.now() - 3600_000).toISOString() }],
    };
    render(<TodayView />);

    expect(screen.getByText(/连续学习 1 天/)).toBeInTheDocument();
    expect(screen.getByText(/近 7 天练了 3 题/)).toBeInTheDocument();
    expect(screen.getByText(/继续上次：LLM记忆三轴分类/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(sessionActions.selectSession).toHaveBeenCalledWith("s1", "course-1");
  });

  describe("新手引导（F1，与旧「今天」说明合并）", () => {
    it("没有课程时展示六步引导入口与执行按钮", () => {
      window.localStorage.clear();
      storeState.onboardingHidden = false;
      render(<TodayView />);
      expect(screen.getByText("开始你的第一门课程")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /开始引导/ })).toBeInTheDocument();
      expect(screen.getByText("新建第一门课程")).toBeInTheDocument();
    });

    it("隐藏后写入本地偏好，可再次打开", () => {
      window.localStorage.clear();
      storeState.onboardingHidden = false;
      render(<TodayView />);
      fireEvent.click(screen.getByRole("button", { name: "隐藏引导" }));
      expect(storeState.setOnboardingHidden).toHaveBeenCalledWith(true);
      expect(window.localStorage.getItem("studyclaw.onboarding.hidden.v1")).toBe("1");
    });

    it("已隐藏的用户不显示引导卡", () => {
      window.localStorage.clear();
      storeState.onboardingHidden = true;
      render(<TodayView />);
      expect(screen.queryByText("开始你的第一门课程")).toBeNull();
    });
  });
});
