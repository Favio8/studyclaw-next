import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState } = vi.hoisted(() => ({
  storeState: {
    progress: {
      overallMastery: 0,
      dueCount: 0,
      lastUpdatedAt: null,
      concepts: [],
    },
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import ProgressTab from "../src/components/panel/ProgressTab";

afterEach(() => cleanup());

describe("ProgressTab", () => {
  it("renders new 0% progress as a neutral waiting state", () => {
    render(<ProgressTab />);

    expect(screen.getByText("等待学习")).toHaveClass("text-text-muted");
    expect(screen.queryByText("需要关注")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "总体掌握度" })).toHaveAttribute("aria-valuenow", "0");
  });
});
