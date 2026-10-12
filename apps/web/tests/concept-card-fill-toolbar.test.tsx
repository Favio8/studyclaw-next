/**
 * 阅读工具条补题入口必须是**单行**（方案 A）：说明行收进 title，不再撑高工具条
 * 导致与旁边控件对不齐；同时修掉「0 个缺题时仍写只为缺题概念生成」的错误文案。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    activeCourseId: "course-1" as string | null,
    conceptCardStatus: null as unknown,
    conceptFill: {
      courseId: null as string | null, jobId: null as string | null, status: "idle" as const,
      total: 0, coveredBefore: 0, processed: 0, generated: 0, currentConcept: null as string | null,
      items: [] as unknown[], error: null as string | null, sharedProblem: null as string | null,
    },
    courseDataRevision: 0,
    setSettingsOpen: vi.fn(),
    setSettingsSection: vi.fn(),
    setConceptCardStatus: vi.fn(),
    setCenterView: vi.fn(),
    setActiveTab: vi.fn(),
    setRightPanelCollapsed: vi.fn(),
    flashStatusBanner: vi.fn(),
  },
  apiMocks: {
    conceptCardStatus: vi.fn(),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks, ApiError: class ApiError extends Error {} }));
vi.mock("../src/lib/panelData", () => ({ refreshPanelData: vi.fn(async () => {}), notifyPanelChanged: vi.fn() }));
vi.mock("../src/lib/quizFlow", () => ({ quizLoad: vi.fn() }));

import ConceptCardFill from "../src/components/panel/ConceptCardFill";

function statusWith(missing: number) {
  return {
    modelReady: true,
    conceptOrigin: "semantic" as const,
    totalConcepts: 26,
    coveredConcepts: 26 - missing,
    missingConcepts: missing,
    missing: [],
    concepts: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.conceptCardStatus = null;
});

describe("ConceptCardFill 工具条变体", () => {
  it("toolbar 变体不渲染覆盖说明行（保持单行），说明进 title", () => {
    storeState.conceptCardStatus = statusWith(2);
    render(<ConceptCardFill variant="toolbar" />);
    expect(screen.queryByText(/已覆盖 \d+\/\d+ 个概念/)).toBeNull();
    const wrapper = screen.getByTestId("concept-fill");
    expect(wrapper.getAttribute("title") ?? "").toContain("全课范围");
    expect(wrapper.getAttribute("title") ?? "").toContain("还有 2 个缺题");
  });

  it("panel 变体保留覆盖说明行，缺题时写明只为缺题概念生成", () => {
    storeState.conceptCardStatus = statusWith(4);
    render(<ConceptCardFill />);
    expect(screen.getByText(/已覆盖 22\/26 个概念 · 4 个缺题，只为缺题概念生成/)).toBeInTheDocument();
  });

  it("panel 变体在零缺题时不再写「只为缺题概念生成」", () => {
    storeState.conceptCardStatus = statusWith(0);
    render(<ConceptCardFill />);
    expect(screen.getByText(/全部概念已有题卡/)).toBeInTheDocument();
    expect(screen.queryByText(/只为缺题概念生成/)).toBeNull();
  });
});
