import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    TextLayerImages: vi.fn(),
  },
}));

vi.mock("pdfjs-dist", () => pdfjsMock);
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({ TextLayerBuilder: pdfjsMock.TextLayer }));
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
function stubPdfjs(numPages = 1) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [{ str: "hello" }] }),
    cleanup: vi.fn(),
  };
  pdfjsMock.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages, getPage: async () => page, cleanup: vi.fn() }),
    destroy: async () => {},
  });
  pdfjsMock.TextLayer.mockImplementation(function () {
    const div = document.createElement("div");
    div.className = "textLayer";
    return { div, render: async () => {}, cancel: vi.fn() };
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
  it("页面连续存在，普通滚轮不再接管翻页，滚动报告页码不会把视口拉回页首", async () => {
    stubPdfjs(5);
    const onPageChange = vi.fn();
    const { container, rerender } = render(<PdfCanvas source="sources/a.pdf" page={1} zoom={1} highlights={[]} onPageCount={vi.fn()} onPageChange={onPageChange} />);
    await waitFor(() => expect(container.querySelectorAll("[data-page-number]")).toHaveLength(5));

    // ---- 几何桩 ------------------------------------------------------------
    // 这个用例要断言"滚动按真实几何报页码"，所以必须给 jsdom 补出布局。
    // 有两个坑，少补一个就得到**看似随机**的失败：
    //
    // 1. jsdom 完全没有 offsetTop/offsetHeight/offsetLeft（不是 0，是 undefined）。
    //    offsetTop + offsetHeight > probe 变成 NaN > probe，恒假 → find() 落空
    //    → 走 pages.at(-1) 兜底 → 页码报成最后一页（5）而不是 2。
    // 2. 锚点还原会算 (scrollLeft + clientWidth/2 - offsetLeft)/offsetWidth 并写回
    //    scrollLeft/scrollTop。任一项 undefined 就产生 NaN，并顺着写入污染
    //    scrollTop —— 页码计算直接变成 NaN 阈值，同样落到兜底。
    //
    // 打桩必须**贴着滚动**且作用在**仍连接在 DOM 上**的节点：组件在 pdf.js 异步
    // 就绪后会重建页面槽，之前抓的节点快照会脱离文档、桩随之失效。
    const withGeometry = <T extends Element>(el: T, values: Record<string, number>): T => {
      for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(el, key, { configurable: true, value });
      }
      return el;
    };
    const applyLayout = (): { scroller: HTMLElement; slots: HTMLElement[] } => {
      const scroller = screen.getByTestId("reader-scroller") as HTMLElement;
      withGeometry(scroller, { clientWidth: 600, clientHeight: 600, offsetWidth: 600, offsetHeight: 600, offsetTop: 0, offsetLeft: 0 });
      const slots = [...scroller.querySelectorAll<HTMLElement>("[data-page-number]")];
      slots.forEach((slot, index) => {
        withGeometry(slot, {
          offsetTop: 16 + index * 816, offsetHeight: 800, offsetWidth: 600,
          offsetLeft: 40, clientWidth: 600, clientHeight: 800,
        });
      });
      return { scroller, slots };
    };
    // scrollTop/scrollLeft 在 jsdom 上是钳成 0 的真访问器（无布局 → 可滚动区为 0），
    // 写入会被丢弃。用可写桩替掉，写入才存得住，末尾"滚动位置未被重置"的断言才有意义。
    const scroller = screen.getByTestId("reader-scroller");
    let scrollTopValue = 0;
    let scrollLeftValue = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true, get: () => scrollTopValue, set: (v: number) => { scrollTopValue = Number.isFinite(v) ? v : scrollTopValue; },
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true, get: () => scrollLeftValue, set: (v: number) => { scrollLeftValue = Number.isFinite(v) ? v : scrollLeftValue; },
    });
    withGeometry(scroller, { clientWidth: 600, clientHeight: 600, offsetWidth: 600, offsetHeight: 600, offsetTop: 0, offsetLeft: 0 });

    const wheel = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);

    await act(async () => {
      // 组件可能已重建子树：重新取并重新打桩，且要求槽确实在文档里。
      const live = applyLayout();
      expect(live.slots).toHaveLength(5);
      expect(live.slots.every(slot => slot.isConnected)).toBe(true);
      live.scroller.scrollTop = 1000;
      fireEvent.scroll(live.scroller);
      // onScroll 用 rAF 节流（PdfCanvas.tsx），页码是在那一帧里算出来的：
      // 显式等一帧，我们的 rAF 排在组件那一个之后，返回时页码必然已算完。
      await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
    });
    expect(onPageChange).toHaveBeenCalledWith(2);
    rerender(<PdfCanvas source="sources/a.pdf" page={2} zoom={1} highlights={[]} onPageCount={vi.fn()} onPageChange={onPageChange} />);
    expect(screen.getByTestId("reader-scroller").scrollTop).toBe(1000);
  });
  it("离屏页不绘制，页级卸载不取消仍在阅读的页面选区监听", async () => {
    stubPdfjs(5);
    const observers = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(element: Element) { observers.set(element, this.callback); }
      disconnect() {}
    });
    const otherPage = { ...HIGHLIGHT, page: 2 };
    const { container } = render(<PdfCanvas source="sources/a.pdf" page={1} zoom={1} highlights={[otherPage]} onPageCount={vi.fn()} onPageChange={vi.fn()} />);
    await waitFor(() => expect(pdfjsMock.TextLayer).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-page-number="5"] canvas')).toBeNull();
    expect(container.querySelector('[data-page-number="2"] [data-testid="pdf-highlight-layer"] div')).not.toBeNull();
    const signal = pdfjsMock.TextLayer.mock.calls[0][0].abortSignal as AbortSignal;
    act(() => observers.get(container.querySelector('[data-page-number="1"]')!)!([{ isIntersecting: false }]));
    expect(signal.aborted).toBe(false);
    expect(container.querySelector('[data-page-number="1"] canvas')).toBeNull();
    expect(container.querySelector('[data-page-number="2"] canvas')).not.toBeNull();
  });
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
    await screen.findByTestId("pdf-page");
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
    // PDF 异步初始化会替换占位页；校验当前页面，避免持有已卸载的旧 DOM。
    expect(screen.getByTestId("pdf-page").contains(layer)).toBe(true);
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
    const overlay = screen.getByTestId("annotation-drawer");
    expect(screen.getByTestId("reader-content").contains(overlay)).toBe(true);
    expect(screen.getByTestId("reader-toolbar").contains(overlay)).toBe(false);
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain("absolute");

    // 再点一次即可关闭。
    screen.getByRole("button", { name: "标注列表" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标注列表" }).getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("宽容器默认让出阅读空间，标注列表仍可主动打开", async () => {
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
    expect(screen.getByRole("button", { name: "标注列表" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("annotation-drawer")).toBeNull();
  });
});
