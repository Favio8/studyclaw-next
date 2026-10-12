import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, heatmapDay } = vi.hoisted(() => ({
  heatmapDay: vi.fn().mockResolvedValue({ date: "2026-08-20", changelog: ["完成调度练习"], events: [] }),
  storeState: {
    activeCourseId: "course-1",
    workspacePath: "/first/course-1",
    heatmap: {
      weeks: 1,
      days: [{ date: "2026-08-20", level: 2 as const, tasks: 2, chatTurns: 1, score: 80, weakSpotsCleared: 0 }],
      streak: { current: 3, best: 5 },
    },
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/api", () => ({
  api: {
    heatmapDay,
  },
}));

import HeatmapTab from "../src/components/panel/HeatmapTab";

afterEach(() => { cleanup(); storeState.workspacePath = "/first/course-1"; });

describe("HeatmapTab", () => {
  it("同名课程切项目后，旧回放响应不能进入新项目", async () => {
    let resolve!: (value: { date: string; changelog: string[]; events: [] }) => void;
    const pending = new Promise<{ date: string; changelog: string[]; events: [] }>((yes) => { resolve = yes; });
    heatmapDay.mockReturnValueOnce(pending);
    const { rerender } = render(<HeatmapTab />);
    fireEvent.click(screen.getByRole("button", { name: "2026-08-20，2 次答题" }));
    storeState.workspacePath = "/another/course-1";
    rerender(<HeatmapTab />);
    await act(async () => { resolve({ date: "2026-08-20", changelog: ["旧项目回放"], events: [] }); await pending; });
    expect(screen.queryByText("旧项目回放")).toBeNull();
    expect(screen.getByText("每日活动")).toBeInTheDocument();
  });
  it("opens a day replay and returns to the heatmap", async () => {
    render(<HeatmapTab />);

    fireEvent.click(screen.getByRole("button", { name: "2026-08-20，2 次答题" }));
    expect(await screen.findByText("学习回放")).toBeInTheDocument();
    expect(screen.getByText("完成调度练习")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回热力图" }));
    expect(screen.getByText("每日活动")).toBeInTheDocument();
  });
});
