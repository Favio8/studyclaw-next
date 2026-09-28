import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, refreshPanelData } = vi.hoisted(() => {
  const refreshPanelData = vi.fn(async () => {});
  return {
    refreshPanelData,
    storeState: {
      progress: {
        overallMastery: 0,
        dueCount: 0,
        lastUpdatedAt: null as string | null,
        concepts: [],
      },
      lastImport: null as unknown,
      activeCourseId: "course-1" as string | null,
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/panelData", () => ({ refreshPanelData, notifyPanelChanged: vi.fn() }));

import ProgressTab from "../src/components/panel/ProgressTab";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("ProgressTab", () => {
  it("renders new 0% progress as a neutral waiting state", () => {
    render(<ProgressTab />);

    expect(screen.getByText("等待学习")).toHaveClass("text-text-muted");
    expect(screen.queryByText("需要关注")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "总体掌握度" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("数据超过 7 天提示可能过期，并提供一键刷新", () => {
    storeState.progress.lastUpdatedAt = daysAgo(30);
    render(<ProgressTab />);

    expect(screen.getByText("可能过期")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "刷新学习数据" });
    fireEvent.click(refresh);
    expect(refreshPanelData).toHaveBeenCalledTimes(1);
    storeState.progress.lastUpdatedAt = null;
  });

  it("新鲜数据不提示过期", () => {
    storeState.progress.lastUpdatedAt = daysAgo(1);
    render(<ProgressTab />);

    expect(screen.queryByText("可能过期")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新学习数据" })).toBeEnabled();
    storeState.progress.lastUpdatedAt = null;
  });

  it("最近导入卡片：同课程才显示，构建结果带出题卡/降级数", () => {
    storeState.lastImport = {
      courseId: "course-1",
      files: ["a.md", "b.pdf", "c.txt", "d.docx"],
      at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      build: { jobId: "job-1", tasksGenerated: 12, degraded: 1 },
    };
    render(<ProgressTab />);

    const card = document.querySelector("[data-last-import]");
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("4 份资料");
    expect(card).toHaveTextContent("构建完成 · 题卡 12 张 · 1 项降级");
    // 超过 3 份只列前三个 + 汇总。
    expect(card).toHaveTextContent("a.md、b.pdf、c.txt");
    expect(card).toHaveTextContent("等 4 份");
    storeState.lastImport = null;
  });

  it("最近导入卡片：切课后不显示（courseId 不匹配）", () => {
    storeState.lastImport = {
      courseId: "other-course",
      files: ["a.md"],
      at: new Date().toISOString(),
      build: null,
    };
    render(<ProgressTab />);
    expect(document.querySelector("[data-last-import]")).toBeNull();
    storeState.lastImport = null;
  });

  it("最近导入卡片：构建中时只显示文件清单", () => {
    storeState.lastImport = {
      courseId: "course-1",
      files: ["a.md"],
      at: new Date().toISOString(),
      build: null,
    };
    render(<ProgressTab />);
    const card = document.querySelector("[data-last-import]");
    expect(card).toHaveTextContent("a.md");
    expect(card).toHaveTextContent("构建中或未启动");
    expect(card).not.toHaveTextContent("构建完成");
    storeState.lastImport = null;
  });
});
