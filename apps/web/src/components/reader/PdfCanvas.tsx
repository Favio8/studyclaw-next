"use client";

/**
 * PDF 阅读画布（PRD 需求三）：pdf.js 单页渲染 + 内置文本层（支持选区），
 * 选区归一化为 0-1 矩形（相对页面宽高）与 quote 双锚，高亮以绝对定位覆盖层
 * 绘制。pdfjs 只在客户端加载（ReaderView 经 next/dynamic ssr:false 挂载），
 * worker 用 module worker 同源打包，不走 CDN。
 *
 * 只依赖 pdfjs-dist：react-pdf-highlighter 现为 RC 且自带旧版 pdfjs-dist，
 * 与 react-pdf 的版本会打架；文本层与选区是 pdf.js 的标准能力，自研后存储
 * 契约（归一化坐标）也无需适配层。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationView } from "@/src/types/api";
import { api } from "@/src/lib/api";
import { readingSelectionChanged } from "@/src/lib/readingFlow";

const PAGE_SCALE = 1.3;
const CONTEXT_CHARS = 40;

interface PdfCanvasProps {
  source: string;
  page: number;
  highlights: AnnotationView[];
  onPageCount: (count: number) => void;
  onPageChange: (page: number) => void;
  onHighlightClick: (id: string) => void;
  /** 文本层为空（扫描件）时回调，ReaderView 据此切解析视图。 */
  onScanned?: (scanned: boolean) => void;
}

/** 容器坐标 → 页面归一化坐标（0-1，相对页面宽高）。 */
function toNormalized(clientRects: DOMRect[], pageEl: HTMLElement): Array<{ x: number; y: number; w: number; h: number }> {
  const base = pageEl.getBoundingClientRect();
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const rect of clientRects) {
    if (rect.width < 1 || rect.height < 1) continue;
    rects.push({
      x: (rect.left - base.left) / base.width,
      y: (rect.top - base.top) / base.height,
      w: rect.width / base.width,
      h: rect.height / base.height,
    });
  }
  return rects;
}

export default function PdfCanvas({ source, page, highlights, onPageCount, onPageChange, onHighlightClick, onScanned }: PdfCanvasProps) {
  const pageElRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 同时持有 loading task 与 document：卸载/换资料时 task.destroy() 才会
  // 真正收掉 pdf.js worker（只 cleanup() document 会泄漏 worker，反复开
  // 文档后 worker 累积）。
  const taskRef = useRef<{ destroy: () => Promise<void> } | null>(null);
  const docRef = useRef<{ numPages: number; getPage: (n: number) => Promise<import("pdfjs-dist").PDFPageProxy> } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  // 文档装载（源文件变化时重载）。
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading");
      setError(null);
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(
          new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
          { type: "module" },
        );
        // 带鉴权抓字节（pdf.js 自己发请求不会带 Bearer token）。
        const bytes = await api.readingFileBytes(source);
        const task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;
        if (cancelled) {
          void doc.cleanup();
          void task.destroy().catch(() => {
            // 已销毁/失败的任务：忽略。
          });
          return;
        }
        taskRef.current = task;
        docRef.current = doc as unknown as typeof docRef.current;
        onPageCount(doc.numPages);
        setStatus("ready");
      } catch (exc) {
        if (cancelled) return;
        setStatus("error");
        setError(exc instanceof Error ? exc.message : String(exc));
      }
    }
    void load();
    return () => {
      cancelled = true;
      const task = taskRef.current;
      taskRef.current = null;
      docRef.current = null;
      if (task !== null) void task.destroy().catch(() => {
        // 卸载即销毁；销毁中的任务报错无意义。
      });
    };
    // onPageCount 是稳定 setState 包装；source 才是重载触发项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // 页面渲染 + 文本层。
  useEffect(() => {
    if (status !== "ready" || docRef.current === null) return;
    let cancelled = false;
    async function render() {
      const pdfjs = await import("pdfjs-dist");
      const doc = docRef.current;
      if (doc === null) return;
      const pdfPage = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled) {
        pdfPage.cleanup();
        return;
      }
      const viewport = pdfPage.getViewport({ scale: PAGE_SCALE });
      const canvas = canvasRef.current;
      const pageEl = pageElRef.current;
      if (canvas === null || pageEl === null) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (context !== null) {
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      }
      // 文本层：pdf.js 内置 TextLayer 产出可选中的 span 网格。
      const textLayer = textLayerRef.current;
      if (textLayer !== null) {
        textLayer.replaceChildren();
        const textContent = await pdfPage.getTextContent();
        // 扫描件：整页零文本项 → 上报，由 ReaderView 切到解析视图（OCR 产物）。
        // 只对文档首页判定：混合型 PDF（前几页有文本、中间夹扫描页）不会
        // 因为翻页在整个视图间反复横跳。
        if (page <= 1) onScanned?.(textContent.items.length === 0);
        const textLayerInstance = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
        });
        await textLayerInstance.render();
      }
    }
    void render().catch((exc: unknown) => {
      if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc));
    });
    return () => {
      cancelled = true;
    };
  }, [page, status, onScanned]);

  // 选区 → 双锚 + 归一化 rects + 浮层锚点。
  const captureSelection = useCallback(() => {
    const pageEl = pageElRef.current;
    const textLayer = textLayerRef.current;
    if (pageEl === null || textLayer === null) return;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
      readingSelectionChanged(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.commonAncestorContainer)) {
      readingSelectionChanged(null);
      return;
    }
    const text = selection.toString().trim();
    if (text === "") {
      readingSelectionChanged(null);
      return;
    }
    const clientRects = Array.from(range.getClientRects());
    const rects = toNormalized(clientRects, pageEl);
    if (rects.length === 0) {
      readingSelectionChanged(null);
      return;
    }
    // quote 前后文：取文本层全文在选区锚点前后的片段（版面变化时重定位用）。
    const full = textLayer.textContent ?? "";
    const at = full.indexOf(text);
    const first = clientRects[0];
    readingSelectionChanged({
      text,
      prefix: at > 0 ? full.slice(Math.max(0, at - CONTEXT_CHARS), at) : "",
      suffix: at >= 0 ? full.slice(at + text.length, at + text.length + CONTEXT_CHARS) : "",
      page,
      rects,
      x: (first?.left ?? 0) + (first?.width ?? 0) / 2,
      y: first?.top ?? 0,
    });
  }, [page]);

  // 滚轮翻页：仅在滚动容器已到顶/到底时接管——否则放大后的页面应该先
  // 正常滚动（旧实现无条件 preventDefault，高页直接滚不动）。
  useEffect(() => {
    const el = pageElRef.current;
    const scroller = el?.parentElement ?? null;
    if (el === null || scroller === null) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 40) return;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const goingDown = event.deltaY > 0;
      if (goingDown ? !atBottom : !atTop) return; // 还有可滚的量，让给原生滚动
      event.preventDefault();
      onPageChange(page + (goingDown ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [page, onPageChange]);

  if (status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-accent-fail" role="alert">
        PDF 打开失败：{error}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto p-4">
      <div
        ref={pageElRef}
        className="relative shrink-0 shadow-lv2"
        onMouseUp={captureSelection}
        data-testid="pdf-page"
      >
        <canvas ref={canvasRef} className="block" />
        {/* 文本层：absolute 覆盖在 canvas 上，提供原生选区能力 */}
        <div ref={textLayerRef} className="absolute inset-0" data-testid="pdf-text-layer" />
        {/* 高亮覆盖层：归一化 rects × 当前渲染尺寸 */}
        {highlights
          .filter((item) => item.page === page)
          .flatMap((item) =>
            item.rects.map((rect, index) => (
              <button
                key={`${item.id}-${index}`}
                type="button"
                title={item.comment !== "" ? item.comment : item.quote.text}
                onClick={() => onHighlightClick(item.id)}
                className={`absolute rounded-sm ${item.color === "yellow" ? "bg-yellow-300/45" : item.color === "green" ? "bg-green-300/45" : item.color === "blue" ? "bg-blue-300/45" : "bg-red-300/45"}`}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              />
            )),
          )}
      </div>
      {status === "loading" ? <p className="py-2 text-[12px] text-text-faint">正在渲染第 {page} 页…</p> : null}
    </div>
  );
}
