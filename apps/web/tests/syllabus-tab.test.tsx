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
  storeState.syllabusCollapsed = {};
  storeState.syllabusSearch = "";
});

describe("SyllabusTab", () => {
  it("switches between the list, mindmap and graph views", async () => {
    render(<SyllabusTab />);

    expect(await screen.findByText("章节与知识点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关系图" }));
    expect(screen.getByTestId("syllabus-graph")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导图" }));
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
});
