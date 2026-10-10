import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PdfCanvas 高亮覆盖层 + ReaderView 窄栏浮层的回归测试。
 *
 * 真机（Edge）验收抓到、此处固化的两个缺陷：
 *
 * 1) 高亮块拦截划词——高亮块曾是可点 <button> 且在 DOM 序上位于 textLayer 之后
 *    （层级更高），于是「已经划过的原文」再也选不中：拖拽落在高亮块上时选区被
 *    按钮吃掉，划词浮层不出现，用户无法二次标注同一段。修复为纯装饰覆盖层
 *    （pointer-events-none 的 div），定位跳转交给标注栏。
 *
 * 2) 窄栏标注浮层关不掉——浮层用 inset-y-0 从顶部铺开，盖住工具条上的「标注」
 *    切换钮，打开后无法关闭。修复为 top-9 起，让开工具条。
 *
 * pdfjs-dist 在 jsdom 里渲染不了：这里 mock 掉，只断言 DOM 结构、层级与指针
 * 事件语义（恰是两个缺陷的成因）；真实像素渲染与命中测试由 scripts/e2e-reader.mjs
 * 在 Edge 上端到端验收。
 */

const { apiMocks, pdfjsMock } = vi.hoisted(() => ({
  apiMocks: {
    readingFileBytes: vi.fn(),
    readingLoad: vi.fn(),
    courseFiles: vi.fn(),
  },
  pdfjsMock: {
    GlobalWorkerOptions: {} as { workerPort?: unknown },
    getDocument: vi.fn(),
    TextLayer: vi.fn(),
  },
}));

vi.mock("pdfjs-dist", () => pdfjsMock);
vi.mock("@/src/lib/api", () => ({
  ApiError: class extends Error {},
  api: apiMocks,
}));
// PdfCanvas 之外的兄弟视图在 ReaderView 里同树渲染，打桩避免拖入真实依赖。
vi.mock("@/src/components/reader/MarkdownReader", () => ({
  default: () => <div data-testid="md-reader" />,
}));
vi.mock("@/src/components/reader/ParsedView", () => ({
  default: () => <div data-testid="parsed-view" />,
}));

import PdfCanvas from "@/src/components/reader/PdfCanvas";
import ReaderView from "@/src/components/reader/ReaderView";
import { useAppStore } from "@/src/store/useAppStore";
import type { AnnotationView } from "@/src/types/api";

const HIGHLIGHT: AnnotationView = {
  id: "hl_1",
  page: 1,
  rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
  quote: { text: "SM-2 的 EF 钳制在 [1.3, 2.9]", prefix: "", suffix: "" },
  color: "yellow",
  comment: "",
  tags: [],
  conceptId: null,
  createdAt: "2026-10-10T00:00:00Z",
};

/** getDocument 打桩：返回一个可渲染的单页文档。 */
function stubPdfjs() {
  const page = {
    getViewport: () => ({ width: 600, height: 800, scale: 1 }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [{ str: "hello" }] }),
    cleanup: vi.fn(),
  };
  pdfjsMock.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 1, getPage: async () => page, cleanup: vi.fn() }),
    destroy: async () => {},
  });
  pdfjsMock.TextLayer.mockImplementation(function () {
    return { render: async () => {}, cancel: vi.fn() };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubPdfjs();
  // jsdom 无 canvas 2d 实现（getContext 返回 null 时 PdfCanvas 跳过绘制）。
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  // jsdom 无 Worker：PdfCanvas 装载时 new Worker(...) 打桩即可（pdfjs 已 mock）。
  vi.stubGlobal("Worker", class {
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  });
  apiMocks.readingFileBytes.mockResolvedValue(new ArrayBuffer(8));
  apiMocks.courseFiles.mockResolvedValue({ files: [], missing: false });
  apiMocks.readingLoad.mockResolvedValue({
    source: "sources/a.pdf",
    view: "pdf",
    exists: true,
    progress: { page: 1, percent: 0, updatedAt: "" },
    highlights: [],
    recovered: false,
  });
  useAppStore.getState().setActiveCourse("course-1");
  useAppStore.getState().readerReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PdfCanvas 高亮覆盖层（回归：已高亮的原文必须仍可划词）", () => {
  it("高亮层是纯装饰覆盖层：pointer-events-none 且不含可点元素", async () => {
    render(
      <PdfCanvas
        source="sources/a.pdf"
        page={1}
        highlights={[HIGHLIGHT]}
        onPageCount={() => {}}
        onPageChange={() => {}}
      />,
    );
    const pageEl = await screen.findByTestId("pdf-page");
    await waitFor(() => expect(screen.getByTestId("pdf-highlight-layer")).toBeInTheDocument());

    const layer = screen.getByTestId("pdf-highlight-layer");
    // 覆盖层必须整体不吃指针事件，否则其下的 textLayer 选不中。
    expect(layer.className).toContain("pointer-events-none");
    // 覆盖层内不得再是可点元素（可点 button 会在 DOM 序上压过 textLayer）。
    expect(layer.querySelectorAll("button")).toHaveLength(0);
    expect(layer.getAttribute("aria-hidden")).toBe("true");

    // 高亮仍按归一化坐标画在页面上。
    const marks = layer.querySelectorAll("div");
    expect(marks).toHaveLength(HIGHLIGHT.rects.length);
    expect((marks[0] as HTMLElement).style.left).toBe(`${HIGHLIGHT.rects[0]!.x * 100}%`);

    // 文本层（可选中的那一层）与页面容器仍然就位。
    expect(pageEl.contains(layer)).toBe(true);
    expect(screen.getByTestId("pdf-text-layer")).toBeInTheDocument();
  });

  it("只渲染当前页的高亮", async () => {
    const otherPage: AnnotationView = { ...HIGHLIGHT, id: "hl_2", page: 2 };
    render(
      <PdfCanvas
        source="sources/a.pdf"
        page={1}
        highlights={[HIGHLIGHT, otherPage]}
        onPageCount={() => {}}
        onPageChange={() => {}}
      />,
    );
    const layer = await screen.findByTestId("pdf-highlight-layer");
    expect(layer.querySelectorAll("div")).toHaveLength(1);
  });
});

describe("ReaderView 窄栏标注浮层（回归：打开后能再关掉）", () => {
  /** 让 ResizeObserver 立刻以给定宽度回调一次，驱动 narrow 判定。 */
  function mockResizeObserverAt(width: number) {
    let cb: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(handler: (entries: Array<{ contentRect: { width: number } }>) => void) {
        cb = handler;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    return () => act(() => cb?.([{ contentRect: { width } }]));
  }

  it("窄容器下标注栏退场为浮层，且浮层让开工具条不遮挡切换钮", async () => {
    useAppStore.getState().setReader({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 1, percent: 0 },
      highlights: [],
    });
    const fireWidth = mockResizeObserverAt(640);

    render(<ReaderView />);
    // 冲刷挂载期的异步 effect（auto-open 资料），避免状态更新落在 act 之外。
    await act(async () => {
      await Promise.resolve();
    });
    fireWidth();

    // 窄容器：常驻栏退场，工具条出现切换钮。
    const toggle = await screen.findByRole("button", { name: "标注列表" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // 浮层容器从工具条下方起（top-9），而不是 inset-y-0 从顶铺开——
    // 后者会盖住这个切换钮，导致打开后无法关闭。
    toggle.click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标注列表" }).getAttribute("aria-expanded")).toBe("true"),
    );
    const overlay = document.querySelector(".absolute.right-0.bottom-0.top-9");
    expect(overlay).not.toBeNull();
    expect(overlay?.className).not.toContain("inset-y-0");

    // 再点一次即可关闭。
    screen.getByRole("button", { name: "标注列表" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标注列表" }).getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("宽容器下标注栏常驻，不出现切换钮", async () => {
    useAppStore.getState().setReader({
      source: "sources/a.pdf",
      view: "pdf",
      exists: true,
      progress: { page: 1, percent: 0 },
      highlights: [],
    });
    const fireWidth = mockResizeObserverAt(1200);

    render(<ReaderView />);
    await act(async () => {
      await Promise.resolve();
    });
    fireWidth();

    expect(await screen.findByText(/标注 0/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标注列表" })).toBeNull();
  });
});