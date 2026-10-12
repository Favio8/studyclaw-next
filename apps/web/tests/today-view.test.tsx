/**
 * M4「今天」视图回归：
 * - 首屏只有一个大数字 + 一个主按钮（信息克制是产品约束，不是实现细节）；
 * - 主按钮的默认动作：有到期卡 → 复习；无到期但有刚划重点 → 回顾原文；都没有 → 不做引导；
 * - 次级信息默认收起，无内容时不渲染空区块。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const quizLoad = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quizFlow", () => ({ quizLoad }));

const storeState = vi.hoisted(() => {
  // 宽松类型：各用例按场景改写 digest 形状
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩需按场景改写
  const state: any = {
    digest: null,
    heatmap: { streak: { current: 0, best: 0 }, weeks: 12, days: [] },
    setCenterView: vi.fn(),
    setActiveTab: vi.fn(),
    setRightPanelCollapsed: vi.fn(),
  };
  return state;
});

vi.mock("../src/store/useAppStore", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 storeState 同理
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

import TodayView from "../src/components/center/TodayView";

it("首次打开静态页面时浏览器存储不造成 hydration 错位", async () => {
  window.localStorage.clear();
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
    expect(container.textContent).toContain("首屏换成了");
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

afterEach(() => {
  cleanup();
  storeState.setCenterView.mockClear();
  storeState.setActiveTab.mockClear();
  storeState.setRightPanelCollapsed.mockClear();
  quizLoad.mockClear();
  storeState.digest = null;
  storeState.heatmap = { streak: { current: 0, best: 0 }, weeks: 12, days: [] };
});

function concept(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: `概念${id}`, chapter: "章一", mastery: 0.2, evals: 0, passRate: 0,
    nextReviewAt: null, exposure: 0, taskCount: 0, annotationCount: 0, lastAnnotatedAt: null,
    ...extra,
  };
}

describe("TodayView 今天", () => {
  it("有到期卡：一个大数字 + 一个主按钮，点击直达复习", () => {
    storeState.digest = { dueCount: 12, concepts: [], recentHighlights: 0 };
    render(<TodayView />);

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("张卡片待复习")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /开始今天/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /开始今天/ }));
    expect(storeState.setCenterView).toHaveBeenCalledWith("chat");
    expect(storeState.setActiveTab).toHaveBeenCalledWith("quiz");
    // 关键：必须真的装载复习流。只切视图不会去取题，主按钮会点出一个空白面板。
    expect(quizLoad).toHaveBeenCalledWith("review");
    expect(storeState.setRightPanelCollapsed).toHaveBeenCalledWith(false);
  });

  it("无到期卡但有刚划的重点：主角数字切换为待回顾条数", () => {
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 3 };
    render(<TodayView />);

    // 不允许出现「0 张卡片待复习」这种自相矛盾的主角数字。
    expect(screen.queryByText("张卡片待复习")).toBeNull();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("条重点待回顾")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开始今天/ }));
    expect(storeState.setCenterView).toHaveBeenCalledWith("reading");
  });

  it("既无到期也无新划线：不做无意义的行动引导", () => {
    storeState.digest = { dueCount: 0, concepts: [], recentHighlights: 0 };
    render(<TodayView />);

    expect(screen.queryByRole("button", { name: /开始今天/ })).toBeNull();
    expect(screen.getByText(/今天没有到期的复习/)).toBeInTheDocument();
  });

  it("次级信息默认收起，展开后才可见", () => {
    storeState.digest = {
      dueCount: 2,
      recentHighlights: 4,
      concepts: [concept("a", { exposure: 3, name: "卷积网络" }), concept("b", { exposure: 0 })],
    };
    render(<TodayView />);

    expect(screen.queryByText(/卷积网络/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /更多/ }));
    expect(screen.getByText(/卷积网络/)).toBeInTheDocument();
    expect(screen.getByText(/近 24 小时划了 4 条重点/)).toBeInTheDocument();
  });

  it("已测过的概念不进「没测过」清单", () => {
    storeState.digest = {
      dueCount: 1,
      recentHighlights: 1,
      concepts: [concept("a", { evals: 3, exposure: 5 }), concept("b", { evals: 0, exposure: 2, name: "注意力机制" })],
    };
    render(<TodayView />);
    fireEvent.click(screen.getByRole("button", { name: /更多/ }));
    expect(screen.getByText(/注意力机制/)).toBeInTheDocument();
  });

  it("无可展开内容时不渲染「更多」", () => {
    storeState.digest = { dueCount: 1, recentHighlights: 0, concepts: [concept("a", { evals: 1 })] };
    render(<TodayView />);
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
  });

  it("digest 未就绪时不报错，退化为空状态", () => {
    storeState.digest = null;
    render(<TodayView />);
    expect(screen.getByText(/今天没有到期的复习/)).toBeInTheDocument();
  });

  describe("首屏变更的一次性说明", () => {
    it("未确认时展示说明卡，确认后不再出现", () => {
      window.localStorage.removeItem("studyclaw.today.explained.v1");
      storeState.digest = { dueCount: 3, concepts: [], recentHighlights: 0 };
      const { unmount } = render(<TodayView />);
      expect(screen.getByRole("button", { name: "知道了" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "知道了" }));
      expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
      unmount();

      // 重新挂载（模拟下次打开）应保持静默。
      render(<TodayView />);
      expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
    });

    it("已确认过的用户直接进入正常视图", () => {
      window.localStorage.setItem("studyclaw.today.explained.v1", "1");
      storeState.digest = { dueCount: 3, concepts: [], recentHighlights: 0 };
      render(<TodayView />);
      expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
      expect(screen.getByRole("button", { name: /开始今天/ })).toBeInTheDocument();
    });
  });
});
