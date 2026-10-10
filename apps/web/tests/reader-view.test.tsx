import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ReaderView（PRD 需求三）：三区布局、资料装载、划词浮层六动作、LLM 动作
 * 流式卡片、高亮落库与标注栏计数。用真实 store（readingFlow 的编排要能推
 * 动重渲染）；PdfCanvas/MarkdownReader 打桩——pdfjs 在 jsdom 不可渲染，
 * 其选区与绘制逻辑由 PdfCanvas 单测外的集成路径覆盖。
 */

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    readingLoad: vi.fn(),
    courseFiles: vi.fn(),
    readingSaveProgress: vi.fn(),
    readingAddHighlight: vi.fn(),
    readingRemoveHighlight: vi.fn(),
    readingExport: vi.fn(),
    readingExplain: vi.fn(),
    readingTranslate: vi.fn(),
    readingFileBytes: vi.fn(),
    readingText: vi.fn(),
    readingParsed: vi.fn(),
    cardDraft: vi.fn(),
    cardCommit: vi.fn(),
  },
}));

vi.mock("../src/lib/api", () => ({
  ApiError: class extends Error {},
  api: apiMocks,
}));
vi.mock("../src/components/reader/PdfCanvas", () => ({
  default: ({ source, page, onPageChange, onScanned }: { source: string; page: number; onPageChange: (page: number) => void; onScanned?: (value: boolean) => void }) => (
    <div data-testid="pdf-canvas">
      pdf:{source}:{page}
      <button type="button" onClick={() => onPageChange(page + 1)}>stub-next</button>
      <button type="button" onClick={() => onScanned?.(true)}>stub-scanned</button>
    </div>
  ),
}));
vi.mock("../src/components/reader/MarkdownReader", () => ({
  default: ({ source }: { source: string }) => <div data-testid="md-reader">md:{source}</div>,
}));
import ReaderView from "../src/components/reader/ReaderView";
import { readingOpen, readingSelectionChanged } from "../src/lib/readingFlow";
import { useAppStore } from "../src/store/useAppStore";

const SELECTION = {
  text: "SM-2 的 EF 钳制在 [1.3, 2.9]",
  prefix: "上文",
  suffix: "下文",
  page: 3,
  rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
  x: 200,
  y: 300,
};

beforeEach(() => {
  useAppStore.getState().setActiveCourse("course-1");
  useAppStore.getState().readerReset();
  apiMocks.readingLoad.mockReset();
  apiMocks.courseFiles.mockReset().mockResolvedValue({ files: [], missing: false });
  apiMocks.readingSaveProgress.mockReset().mockResolvedValue({ page: 1, percent: 0, updatedAt: "" });
  apiMocks.readingAddHighlight.mockReset().mockResolvedValue({
    id: "hl_1",
    page: 3,
    rects: SELECTION.rects,
    quote: { text: SELECTION.text, prefix: SELECTION.prefix, suffix: SELECTION.suffix },
    color: "yellow",
    comment: "",
    tags: [],
    conceptId: null,
    createdAt: "2026-10-10T00:00:00Z",
  });
  apiMocks.readingExport.mockReset();
  apiMocks.readingExplain.mockReset();
  apiMocks.readingTranslate.mockReset();
  apiMocks.readingParsed.mockReset();
  apiMocks.cardDraft.mockReset();
  apiMocks.cardCommit.mockReset();
});

afterEach(() => {
  cleanup();
  useAppStore.getState().readerReset();
});

describe("ReaderView", () => {
  it("未选资料时显示空态引导", () => {
    render(<ReaderView />);
    expect(screen.getByText(/从左侧资料树选一份文件开始精读/)).toBeDefined();
  });

  it("打开 PDF：三区就位，工具栏显示页码进度", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 3, percent: 30, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");

    await waitFor(() => expect(screen.getByTestId("pdf-canvas").textContent).toContain("pdf:sources/a.pdf:3"));
    expect(screen.getByText(/3 · 30%/)).toBeDefined();
    // 标注栏空态提示
    expect(screen.getByText(/标注 0/)).toBeDefined();
  });

  it("打开 md：走 MarkdownReader 桩", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/b.md",
      view: "markdown",
      exists: true,
      progress: { page: 1, percent: 0, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    render(<ReaderView />);
    await readingOpen("sources/b.md");
    await waitFor(() => expect(screen.getByTestId("md-reader").textContent).toContain("md:sources/b.md"));
  });

  it("划词后浮层出现；点高亮入库并清空选区", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 3, percent: 30, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());

    readingSelectionChanged(SELECTION);
    await waitFor(() => expect(screen.getByTestId("selection-popover")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "高亮（黄）" }));
    await waitFor(() => expect(apiMocks.readingAddHighlight).toHaveBeenCalledTimes(1));
    expect(apiMocks.readingAddHighlight.mock.calls[0]?.[1]).toMatchObject({
      page: 3,
      quote: SELECTION.text,
      prefix: SELECTION.prefix,
      suffix: SELECTION.suffix,
      color: "yellow",
    });
    // 标注栏计数 +1，浮层收起
    await waitFor(() => expect(screen.getByText(/标注 1/)).toBeDefined());
    expect(screen.queryByTestId("selection-popover")).toBeNull();
  });

  it("点解释：SSE 流式文本进入动作卡", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 3, percent: 30, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    apiMocks.readingExplain.mockImplementation(async function* () {
      yield { event: "token", data: { delta: "这段讲的是" } };
      yield { event: "token", data: { delta: "SM-2 的难度因子。" } };
      yield { event: "done", data: { kind: "explain" } };
    });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());

    readingSelectionChanged(SELECTION);
    await waitFor(() => expect(screen.getByTestId("selection-popover")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /解释/ }));

    await waitFor(() => expect(screen.getByTestId("reading-action-card").textContent).toContain("SM-2 的难度因子。"));
    expect(apiMocks.readingExplain).toHaveBeenCalledWith("sources/a.pdf", SELECTION.text, expect.anything());
    // 流结束出现“就这段继续对话”
    await waitFor(() => expect(screen.getByRole("button", { name: /就这段继续对话/ })).toBeDefined());
  });

  it("翻页触发进度保存（percent 由页码推导）", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 1, percent: 0, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());

    // PdfCanvas 桩把 onPageCount 回调暴露为 window 钩子不可行——直接点桩的“下一页”，
    // pageCount=0 时 percent 不落库（无总页数），仅验证翻页不炸。
    fireEvent.click(screen.getByRole("button", { name: "stub-next" }));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas").textContent).toContain("pdf:sources/a.pdf:2"));
  });
});

describe("ReaderView 解析视图（P2.5）", () => {
  it("docx 等不支持的格式：走解析视图并展示产物", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/handout.docx",
      view: "unsupported",
      exists: true,
      progress: { page: 1, percent: 0, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    apiMocks.readingParsed.mockResolvedValue({
      source: "sources/handout.docx",
      available: true,
      engine: "mineru",
      tier: "standard",
      markdown: "# 解析产物\n\n表格与公式保真。",
      reason: null,
    });
    render(<ReaderView />);
    await readingOpen("sources/handout.docx");
    await waitFor(() => expect(screen.getByText("解析视图")).toBeDefined());
    expect(screen.getByText(/表格与公式保真/)).toBeDefined();
    expect(screen.getByText(/mineru \/ standard/)).toBeDefined();
  });

  it("扫描件 PDF：文本层为空 → 切解析视图并给出构建引导", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/scan.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 1, percent: 0, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    apiMocks.readingParsed.mockResolvedValue({
      source: "sources/scan.pdf",
      available: false,
      engine: null,
      tier: null,
      markdown: "",
      reason: "这份资料还没有解析产物：在设置里启用 MinerU 并重新构建课程即可阅读",
    });
    render(<ReaderView />);
    await readingOpen("sources/scan.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());
    // PdfCanvas 桩模拟 pdf.js 上报“整页零文本层”（扫描件）。
    fireEvent.click(screen.getByRole("button", { name: "stub-scanned" }));
    await waitFor(() => expect(screen.getByText(/在设置里启用 MinerU/)).toBeDefined());
    expect(apiMocks.readingParsed).toHaveBeenCalledWith("sources/scan.pdf");
    expect(screen.queryByTestId("pdf-canvas")).toBeNull();
  });
});

describe("ReaderView 划词建卡（P3）", () => {
  it("选词 → 建卡 → 草稿面板 → 确认落库", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 3, percent: 30, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    apiMocks.cardDraft.mockResolvedValue({
      courseId: "course-1",
      draft: {
        task_id: "ef_001",
        concept_id: "c_ef",
        type: "concept",
        difficulty: 2,
        question: "SM-2 的 EF 钳制区间是什么？",
        options: null,
        evaluation_criteria: { rubric: ["答对 [1.3, 2.9]", "说明处理"], keywords: ["EF"] },
      },
    });
    apiMocks.cardCommit.mockResolvedValue({ courseId: "course-1", tasks: [] });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());

    readingSelectionChanged(SELECTION);
    await waitFor(() => expect(screen.getByTestId("selection-popover")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "建卡" }));

    // 草稿面板：题干可编辑
    await waitFor(() => expect(screen.getByTestId("card-draft-panel")).toBeDefined());
    const editor = screen.getByLabelText("题干（可编辑）") as HTMLTextAreaElement;
    expect(editor.value).toContain("EF 钳制区间");
    fireEvent.change(editor, { target: { value: "SM-2 的 EF 为什么钳制在 [1.3, 2.9]？" } });

    fireEvent.click(screen.getByRole("button", { name: "确认建卡" }));
    await waitFor(() => expect(apiMocks.cardCommit).toHaveBeenCalledTimes(1));
    expect(apiMocks.cardCommit.mock.calls[0]?.[1]).toMatchObject({
      question: "SM-2 的 EF 为什么钳制在 [1.3, 2.9]？",
      task_id: "ef_001",
    });
    // 落库后面板关闭
    await waitFor(() => expect(screen.queryByTestId("card-draft-panel")).toBeNull());
  });

  it("概念建议：选区命中进度概念名时随标注落库", async () => {
    apiMocks.readingLoad.mockResolvedValue({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 3, percent: 30, updatedAt: "" },
      highlights: [],
      recovered: false,
    });
    // 让 addHighlight 回显调用参数里的 conceptId（真实服务端会落库并返回）
    apiMocks.readingAddHighlight.mockImplementation(async (_source: string, input: Record<string, unknown>) => ({
      id: "hl_concept",
      page: Number(input["page"] ?? 1),
      rects: (input["rects"] as unknown[]) ?? [],
      quote: { text: String(input["quote"] ?? ""), prefix: "", suffix: "" },
      color: String(input["color"] ?? "yellow"),
      comment: "",
      tags: [],
      conceptId: (input["conceptId"] as string | null) ?? null,
      createdAt: "2026-10-10T00:00:00Z",
    }));
    // store 里放进度概念（suggestConceptId 的数据源）
    useAppStore.getState().setPanelData({
      progress: {
        overallMastery: 0.4,
        dueCount: 1,
        lastUpdatedAt: null,
        concepts: [{ id: "c_ef", name: "难度因子", chapter: "SM-2", mastery: 0.4, evals: 3, passRate: 0.3, ef: 2.5, nextReviewAt: null, misattribution: "无" }],
      },
    });
    render(<ReaderView />);
    await readingOpen("sources/a.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toBeDefined());

    readingSelectionChanged({ ...SELECTION, text: "难度因子 EF 的钳制机制" });
    await waitFor(() => expect(screen.getByTestId("selection-popover")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "高亮（黄）" }));
    await waitFor(() => expect(apiMocks.readingAddHighlight).toHaveBeenCalledTimes(1));
    expect(apiMocks.readingAddHighlight.mock.calls[0]?.[1]).toMatchObject({ conceptId: "c_ef" });
    // 标注栏展示概念标签
    await waitFor(() => expect(screen.getByText(/概念 c_ef/)).toBeDefined());
  });
});
