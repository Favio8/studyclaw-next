import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 中栏一级学习活动（PRD 需求二，选项 B）：
 * - 五个活动入口与激活态（M4 起「今天」为一等活动且是默认落地页）；
 * - 测验/复习 = 聚焦右栏 quiz 面板并按模式装载（quizFlow 活跃流是模块级
 *   单例，中栏不挂第二实例——双实例会互相中止）；
 * - 阅读 = 中栏切到独立视图；
 * - 对话风格分段控件切换 store.mode；
 * - 选中会话回到对话活动。
 *
 * 用真实 store：活动切换的核心就是 store 状态流转，mock store 没有订阅机制。
 */

const { quizLoad } = vi.hoisted(() => ({ quizLoad: vi.fn() }));
vi.mock("../src/lib/quizFlow", () => ({ quizLoad, abortActiveEval: vi.fn() }));

import CenterSwitcher from "../src/components/center/CenterSwitcher";
import { useAppStore } from "../src/store/useAppStore";

beforeEach(() => useAppStore.getState().setCenterView("today"));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.getState().setCenterView("chat");
});

describe("CenterSwitcher 学习活动", () => {
  it("仅保留今天、对话、阅读，题卡由右栏承载", () => {
    render(<CenterSwitcher />);
    // M4 起「今天」是一等学习活动，也是默认落地页。
    for (const label of ["今天", "对话", "阅读"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "今天" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "阅读" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "测验" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复习" })).toBeNull();
  });

  it("点阅读 → centerView=reading", () => {
    render(<CenterSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    expect(useAppStore.getState().centerView).toBe("reading");
  });

  it("点对话显示对话风格，导航不启动题卡流", () => {
    render(<CenterSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(quizLoad).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.centerView).toBe("chat");
  });

  it("对话风格分段控件：点击切换 mode 并闪切换横幅", () => {
    useAppStore.getState().setCenterView("chat");
    render(<CenterSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "费曼输出" }));
    expect(useAppStore.getState().mode).toBe("feynman");
    expect(useAppStore.getState().modeBanner).toContain("费曼输出");
  });

  it("切到阅读后风格组隐藏（风格只属于对话活动）", () => {
    useAppStore.getState().setCenterView("chat");
    render(<CenterSwitcher />);
    expect(screen.getByRole("group", { name: "对话风格" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    expect(screen.queryByRole("group", { name: "对话风格" })).toBeNull();
  });

  it("选中会话（setActiveSession）把中栏带回对话活动", () => {
    useAppStore.getState().setCenterView("reading");
    useAppStore.getState().setActiveSession("s1", "标题");
    expect(useAppStore.getState().centerView).toBe("chat");
  });
});
