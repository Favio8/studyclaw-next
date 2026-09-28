import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, setActiveTab, setRightPanelCollapsed } = vi.hoisted(() => {
  const setActiveTab = vi.fn();
  const setRightPanelCollapsed = vi.fn();
  return {
    setActiveTab,
    setRightPanelCollapsed,
    storeState: {
      activeTab: "progress" as const,
      setActiveTab,
      rightPanelCollapsed: false as boolean,
      setRightPanelCollapsed,
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

  it("头部有折叠右栏按钮，点击收起（Ctrl+B 同效）", () => {
    render(<RightPanel />);
    const collapse = screen.getByRole("button", { name: "折叠右栏" });
    expect(collapse).toHaveAttribute("title", "折叠右栏（Ctrl+B）");
    fireEvent.click(collapse);
    expect(setRightPanelCollapsed).toHaveBeenCalledWith(true);
  });

  it("折叠态下 RightPanel 自身照常渲染（隐藏由 Console 的 section 负责，故不卸载）", () => {
    storeState.rightPanelCollapsed = true;
    render(<RightPanel />);
    // 折叠不等于卸载：Tab 与内容仍在 DOM 里，Console 只是把外层 section display:none。
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tabpanel", { name: "进度" })).toHaveTextContent("进度内容");
    expect(screen.getByRole("button", { name: "折叠右栏" })).toBeTruthy();
    storeState.rightPanelCollapsed = false;
  });
});
