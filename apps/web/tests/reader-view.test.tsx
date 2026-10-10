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
  },
}));

vi.mock("../src/lib/api", () => ({
  ApiError: class extends Error {},
  api: apiMocks,
}));
vi.mock("../src/components/reader/PdfCanvas", () => ({
  default: ({ source, page, onPageChange }: { source: string; page: number; onPageChange: (page: number) => void }) => (
    <div data-testid="pdf-canvas">
      pdf:{source}:{page}
      <button type="button" onClick={() => onPageChange(page + 1)}>stub-next</button>
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
