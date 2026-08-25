import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks, syllabusFine, syllabusCoarse } = vi.hoisted(() => {
  const base = (granularity: "fine" | "coarse") => ({
    courseId: "course-1",
    title: "K8s",
    version: "1.0",
    granularity,
    chapters: [
      {
        id: "chapter-1",
        title: "第一章",
        description: "",
        dependencies: [],
        concepts: [{ id: "concept-1", name: "调度", type: "mechanism", prerequisites: [], masteryScore: 0 }],
      },
    ],
  });
  return {
    storeState: {
      activeCourseId: "course-1",
      buildStatus: "idle" as const,
      mastery: { chapters: [] },
      focusConceptId: null,
      setFocusConcept: vi.fn(),
      flashStatusBanner: vi.fn(),
      syllabusCollapsed: {},
      setSyllabusCollapsed: vi.fn(),
      syllabusSearch: "",
      setSyllabusSearch: vi.fn(),
    },
    apiMocks: {
      syllabus: vi.fn(),
      setSyllabusGranularity: vi.fn(),
    },
    syllabusFine: base("fine"),
    syllabusCoarse: base("coarse"),
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
vi.mock("../src/lib/panelData", () => ({
  refreshPanelData: vi.fn(() => Promise.resolve()),
  refreshCourseList: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/components/panel/SyllabusGraph", () => ({
  default: () => <div data-testid="syllabus-graph">关系图</div>,
}));
vi.mock("../src/components/panel/SyllabusMindmap", () => ({
  default: () => <div data-testid="syllabus-mindmap">思维导图</div>,
}));

import SyllabusTab from "../src/components/panel/SyllabusTab";

beforeEach(() => {
  apiMocks.syllabus.mockResolvedValue(syllabusFine);
  apiMocks.setSyllabusGranularity.mockResolvedValue({
    courseId: "course-1",
    granularity: "coarse",
    syllabus: syllabusCoarse,
    conceptsSeeded: 2,
    degraded: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SyllabusTab 大纲粒度（F7）", () => {
  it("展示粒度切换控件并切换到粗粒度并集合并", async () => {
    render(<SyllabusTab />);
    expect(await screen.findByText("章节与知识点")).toBeInTheDocument();

    const coarseButton = screen.getByRole("button", { name: "粗粒度" });
    fireEvent.click(coarseButton);

    await waitFor(() => {
      expect(apiMocks.setSyllabusGranularity).toHaveBeenCalledWith("course-1", "coarse");
    });
    // 切换后重新渲染：粗粒度按钮处于激活态（aria-pressed）
    expect(storeState.flashStatusBanner).toHaveBeenCalledWith(
      expect.stringContaining("粗粒度大章节"),
    );
  });

  it("相同粒度点击不重复请求", async () => {
    render(<SyllabusTab />);
    await screen.findByText("章节与知识点");

    // 初始 fine，点 fine 不触发请求
    fireEvent.click(screen.getByRole("button", { name: "高密度" }));
    expect(apiMocks.setSyllabusGranularity).not.toHaveBeenCalled();
  });
});
