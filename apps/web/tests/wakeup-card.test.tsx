import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, wakeupMocks, getStateMock } = vi.hoisted(() => ({
  storeState: {
    activeCourseId: "course-1",
    setWakeupCard: vi.fn(),
  },
  wakeupMocks: {
    submitWakeupAnswer: vi.fn(),
  },
  // 爪爪结果脉冲（P1）：WakeupCard 评测后经 getState 写入。
  // 注意 afterEach 的 clearAllMocks 只清调用记录不清实现，但 mock 工厂
  // 返回对象上的普通函数属性会在 clear 后保留——这里用 vi.fn 独立持有，
  // 避免被模块级对象引用差异吞掉。
  getStateMock: vi.fn(() => ({ setMascotPulse: vi.fn() })),
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: getStateMock },
  ),
}));
vi.mock("../src/lib/wakeup", () => ({
  submitWakeupAnswer: wakeupMocks.submitWakeupAnswer,
}));
vi.mock("../src/lib/panelData", () => ({
  refreshCourseList: vi.fn(() => Promise.resolve()),
  refreshPanelData: vi.fn(() => Promise.resolve()),
}));

import WakeupCard from "../src/components/chat/WakeupCard";
import type { WakeupCard as WakeupCardType } from "../src/types/api";

const card: WakeupCardType = {
  taskId: "weak_001",
  conceptId: "c_weak",
  type: "concept",
  difficulty: 1,
  question: "为什么 Pod 会 Pending？",
  options: null,
  skippable: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WakeupCard（F6 学习中断唤醒）", () => {
  it("渲染快问快答并支持跳过", () => {
    render(<WakeupCard card={card} />);
    expect(screen.getByText("为什么 Pod 会 Pending？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    expect(storeState.setWakeupCard).toHaveBeenCalledWith(null);
  });

  it("作答纳入评测闭环：调用 submitWakeupAnswer 并显示判定", async () => {
    wakeupMocks.submitWakeupAnswer.mockResolvedValue({
      passed: true,
      score: 1,
      feedback: "答对",
      misconceptions: [],
      nextReviewAt: "2026-08-21",
      masteryDelta: 0.4,
    });
    render(<WakeupCard card={card} />);
    fireEvent.change(screen.getByLabelText("唤醒快问答作"), {
      target: { value: "因为节点标签不匹配" },
    });
    fireEvent.click(screen.getByRole("button", { name: "作答" }));

    await waitFor(() => {
      expect(wakeupMocks.submitWakeupAnswer).toHaveBeenCalledWith(
        "course-1",
        "weak_001",
        "因为节点标签不匹配",
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("唤醒快问答对");
    });
  });

  it("评测失败给出错误提示且不消失", async () => {
    wakeupMocks.submitWakeupAnswer.mockRejectedValue(new Error("LLM 服务不可用"));
    render(<WakeupCard card={card} />);
    fireEvent.change(screen.getByLabelText("唤醒快问答作"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "作答" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("LLM 服务不可用");
    });
  });
});
