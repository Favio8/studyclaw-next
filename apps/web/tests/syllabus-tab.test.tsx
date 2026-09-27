import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, syllabus } = vi.hoisted(() => {
  const storeState = {
    activeCourseId: "course-1",
    buildStatus: "idle" as const,
    mastery: { chapters: [] },
    focusConceptId: null,
    setFocusConcept: vi.fn(),
    flashStatusBanner: vi.fn(),
    syllabusCollapsed: {} as Record<string, boolean>,
    setSyllabusCollapsed: vi.fn((chapterId: string, collapsed: boolean) => {
      storeState.syllabusCollapsed = { ...storeState.syllabusCollapsed, [chapterId]: collapsed };
    }),
    syllabusSearch: "",
    setSyllabusSearch: vi.fn((search: string) => {
      storeState.syllabusSearch = search;
    }),
    syllabusView: "tree" as "tree" | "mindmap" | "graph",
    setSyllabusView: vi.fn((view: string) => {
      storeState.syllabusView = view as never;
    }),
    syllabusMindmapCollapsed: {} as Record<string, boolean>,
    setSyllabusMindmapCollapsed: vi.fn(),
    syllabusStatusFilter: null as string | null,
    setSyllabusStatusFilter: vi.fn((filter: string | null) => {
      storeState.syllabusStatusFilter = filter;
    }),
  };
  const syllabus = {
    courseId: "course-1",
    title: "Kubernetes 基础",
    version: "1.0",
    granularity: "fine" as const,
    chapters: [
      {
        id: "chapter-1",
        title: "第一章",
        description: "",
        dependencies: [],
        concepts: [
          { id: "concept-1", name: "调度", type: "mechanism" as const, prerequisites: [], masteryScore: 0 },
          { id: "concept-2", name: "网络策略", type: "mechanism" as const, prerequisites: [], masteryScore: 0 },
        ],
      },
      {
        id: "chapter-2",
        title: "第二章",
        description: "",
        dependencies: [],
        concepts: [{ id: "concept-3", name: "存储卷", type: "mechanism" as const, prerequisites: [], masteryScore: 0 }],
      },
    ],
  };
  return { storeState, syllabus };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/api", () => ({ api: { syllabus: vi.fn().mockResolvedValue(syllabus) } }));
vi.mock("../src/components/panel/SyllabusGraph", () => ({
  default: () => <div data-testid="syllabus-graph">关系图</div>,
}));
vi.mock("../src/components/panel/SyllabusMindmap", () => ({
  default: () => <div data-testid="syllabus-mindmap">思维导图</div>,
}));

import SyllabusTab from "../src/components/panel/SyllabusTab";

afterEach(() => {
  cleanup();
  // 清理 mock 调用记录（保留实现）：调用历史跨用例累积，加入次数类断言
  // 即会假红/假绿；与 right-panel/settings-dialog 测试保持同一清理约定。
  vi.clearAllMocks();
  storeState.syllabusCollapsed = {};
  storeState.syllabusSearch = "";
  storeState.syllabusView = "tree";
  storeState.syllabusStatusFilter = null;
});

describe("SyllabusTab", () => {
  it("switches between the list, mindmap and graph views", async () => {
    const { rerender } = render(<SyllabusTab />);

    expect(await screen.findByText("章节与知识点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关系图" }));
    rerender(<SyllabusTab />);
    expect(screen.getByTestId("syllabus-graph")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导图" }));
    rerender(<SyllabusTab />);
    await waitFor(() => expect(screen.getByTestId("syllabus-mindmap")).toBeInTheDocument());
  });

  it("filters concepts by search and shows a no-match state", async () => {
    const { rerender } = render(<SyllabusTab />);
    await screen.findByText("章节与知识点");

    storeState.syllabusSearch = "网络策略";
    rerender(<SyllabusTab />);
    expect(screen.getByText("网络策略")).toBeInTheDocument();
    expect(screen.queryByText("调度")).not.toBeInTheDocument();
    expect(screen.queryByText("存储卷")).not.toBeInTheDocument();

    storeState.syllabusSearch = "不存在的内容";
    rerender(<SyllabusTab />);
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  it("keeps collapsed chapters in the store", async () => {
    render(<SyllabusTab />);
    await screen.findByText("第一章");

    fireEvent.click(screen.getByRole("button", { name: /第一章/ }));
    expect(storeState.setSyllabusCollapsed).toHaveBeenCalledWith("chapter-1", true);
  });

  it("filts concepts by status legend and resets via retoggle", async () => {
    const { rerender } = render(<SyllabusTab />);
    await screen.findByText("章节与知识点");

    // 无掌握度数据 → 全部概念默认 locked。
    storeState.syllabusStatusFilter = "mastered";
    rerender(<SyllabusTab />);
    expect(screen.queryByText("调度")).not.toBeInTheDocument();
    expect(screen.queryByText("网络策略")).not.toBeInTheDocument();

    storeState.syllabusStatusFilter = null;
    rerender(<SyllabusTab />);
    expect(screen.getByText("调度")).toBeInTheDocument();
  });

  it("keeps the selected view in the store and restores it", async () => {
    const { rerender } = render(<SyllabusTab />);
    await screen.findByText("章节与知识点");

    fireEvent.click(screen.getByRole("button", { name: "导图" }));
    expect(storeState.syllabusView).toBe("mindmap");

    storeState.syllabusView = "graph";
    rerender(<SyllabusTab />);
    const graph = await screen.findByTestId("syllabus-graph");
    expect(graph).toBeInTheDocument();
  });
});
