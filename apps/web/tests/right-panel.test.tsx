import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, setActiveTab } = vi.hoisted(() => {
  const setActiveTab = vi.fn();
  return {
    setActiveTab,
    storeState: {
      activeTab: "progress" as const,
      setActiveTab,
      badges: { progress: false, syllabus: true, heatmap: false, quiz: false },
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/components/panel/ProgressTab", () => ({ default: () => <div>进度内容</div> }));
vi.mock("../src/components/panel/SyllabusTab", () => ({ default: () => <div>大纲内容</div> }));
vi.mock("../src/components/panel/HeatmapTab", () => ({ default: () => <div>热力内容</div> }));
vi.mock("../src/components/panel/QuizTab", () => ({ default: () => <div>题卡内容</div> }));

import RightPanel from "../src/components/panel/RightPanel";

afterEach(() => {
  cleanup();
  setActiveTab.mockClear();
});

describe("RightPanel", () => {
  it("exposes a labelled tablist and connects every tab to its panel", () => {
    render(<RightPanel />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "进度" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "大纲" })).toHaveAttribute("aria-controls", "panel-syllabus");
    expect(screen.getByRole("tabpanel", { name: "大纲", hidden: true })).toHaveAttribute("aria-labelledby", "tab-syllabus");
    expect(screen.getByRole("tabpanel", { name: "进度" })).toHaveTextContent("进度内容");
    expect(screen.getByRole("tabpanel", { name: "大纲", hidden: true })).toHaveClass("hidden");
  });

  it("keeps Ctrl shortcut semantics discoverable and changes tabs on click", () => {
    render(<RightPanel />);

    const syllabusTab = screen.getByRole("tab", { name: "大纲" });
    expect(syllabusTab).toHaveAttribute("title", "大纲（Ctrl+2）");
    fireEvent.click(syllabusTab);
    expect(setActiveTab).toHaveBeenCalledWith("syllabus");
  });
});
