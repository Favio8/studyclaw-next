import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState } = vi.hoisted(() => ({
  storeState: {
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
    heatmapDay: vi.fn().mockResolvedValue({ date: "2026-08-20", changelog: ["完成调度练习"], events: [] }),
  },
}));

import HeatmapTab from "../src/components/panel/HeatmapTab";

afterEach(() => cleanup());

describe("HeatmapTab", () => {
  it("opens a day replay and returns to the heatmap", async () => {
    render(<HeatmapTab />);

    fireEvent.click(screen.getByRole("button", { name: "2026-08-20，2 次答题" }));
    expect(await screen.findByText("学习回放")).toBeInTheDocument();
    expect(screen.getByText("完成调度练习")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回热力图" }));
    expect(screen.getByText("每日活动")).toBeInTheDocument();
  });
});
