"use client";

/** Continuous PDF pages with viewport-based painting, selectable text and annotations. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { TextLayerBuilder } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { AnnotationView } from "@/src/types/api";
import { api } from "@/src/lib/api";
import { readingSelectionChanged } from "@/src/lib/readingFlow";
import { useAppStore } from "@/src/store/useAppStore";
import { readerScale, stepZoom, type ReaderZoom } from "@/src/lib/readerZoom";

interface PdfCanvasProps {
  zoom?: ReaderZoom;
  onScale?: (scale: number) => void;
  onZoom?: (zoom: ReaderZoom) => void;
  source: string;
  page: number;
  highlights: AnnotationView[];
  onPageCount: (count: number) => void;
  onPageChange: (page: number) => void;
  onScanned?: (scanned: boolean) => void;
}

interface LoadedPdf {
  proxy: PDFDocumentProxy;
  runtime: typeof import("pdfjs-dist");
  TextLayer: typeof import("pdfjs-dist/web/pdf_viewer.mjs").TextLayerBuilder;
  sizes: Array<{ width: number; height: number }>;
  selectionSignal: AbortSignal;
}
interface PageGeometry { width: number; height: number; scale: number }
interface ScrollAnchor { page: number; y: number; x: number }

export default function PdfCanvas(props: PdfCanvasProps) {
  return <PdfDocument key={props.source} {...props} />;
}

function PdfDocument({ source, page, highlights, onPageCount, onPageChange, onScanned, zoom = "width", onScale, onZoom }: PdfCanvasProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [initialPage] = useState(page);
  const reportedPage = useRef<number | null>(null);
  const requestedPage = useRef<number | null>(null);
  const layout = useRef<PageGeometry[] | null>(null);
  const anchor = useRef<ScrollAnchor | null>(null);
  const frame = useRef<number | null>(null);
  const callbacks = useRef({ onPageCount, onPageChange, onScale, onZoom });
  useLayoutEffect(() => { callbacks.current = { onPageCount, onPageChange, onScale, onZoom }; }, [onPageCount, onPageChange, onScale, onZoom]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setSize(current => {
      const width = scroller.clientWidth || window.innerWidth;
      const height = scroller.clientHeight || window.innerHeight;
      return current.width === width && current.height === height ? current : { width, height };
    });
    const initialMeasure = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => { cancelAnimationFrame(initialMeasure); observer?.disconnect(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | undefined;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    const selection = new AbortController();
    async function load() {
      try {
        // The viewer module consumes globalThis.pdfjsLib initialized by pdfjs.
        const pdfjs = await import("pdfjs-dist");
        const { TextLayerBuilder } = await import("pdfjs-dist/web/pdf_viewer.mjs");
        const bytes = await api.readingFileBytes(source);
        if (cancelled) return;
        worker = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
        pdfjs.GlobalWorkerOptions.workerPort = worker;
        task = pdfjs.getDocument({ data: bytes });
        const proxy = await task.promise;
        const sizes = await Promise.all(Array.from({ length: proxy.numPages }, async (_, index) => {
          const viewport = (await proxy.getPage(index + 1)).getViewport({ scale: 1 });
          return { width: viewport.width, height: viewport.height };
        }));
        if (cancelled) return;
        callbacks.current.onPageCount(proxy.numPages);
        setDocument({ proxy, runtime: pdfjs, TextLayer: TextLayerBuilder, sizes, selectionSignal: selection.signal });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void load();
    return () => {
      cancelled = true;
      selection.abort();
      void task?.destroy().catch(() => {});
      worker?.terminate();
    };
  }, [source]);

  const geometry = useMemo(() => document?.sizes.map(pageSize => {
    const scale = readerScale(zoom, size.width, size.height, pageSize.width, pageSize.height);
    return { width: pageSize.width * scale, height: pageSize.height * scale, scale };
  }) ?? [], [document, zoom, size]);

  const rememberAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pages = [...scroller.querySelectorAll<HTMLElement>("[data-page-number]")];
    const center = scroller.scrollTop + scroller.clientHeight / 2;
    const target = pages.find(item => item.offsetTop + item.offsetHeight > center) ?? pages.at(-1);
    if (target) anchor.current = {
      page: Number(target.dataset.pageNumber),
      y: (center - target.offsetTop) / target.offsetHeight,
      x: (scroller.scrollLeft + scroller.clientWidth / 2 - target.offsetLeft) / target.offsetWidth,
    };
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !geometry.length) return;
    const requested = Math.max(1, Math.min(page, geometry.length));
    if (layout.current !== geometry) {
      if (useAppStore.getState().reader.selection) readingSelectionChanged(null);
      const current = anchor.current;
      if (layout.current && current) {
        const target = scroller.querySelector<HTMLElement>(`[data-page-number="${current.page}"]`);
        if (target) {
          scroller.scrollTop = target.offsetTop + target.offsetHeight * current.y - scroller.clientHeight / 2;
          scroller.scrollLeft = target.offsetLeft + target.offsetWidth * current.x - scroller.clientWidth / 2;
        }
      }
      layout.current = geometry;
    }
    // A scroll report updates the toolbar; it must not snap the viewport back.
    if (requestedPage.current === null || (page !== requestedPage.current && requested !== reportedPage.current)) {
      const target = scroller.querySelector<HTMLElement>(`[data-page-number="${requested}"]`);
      reportedPage.current = requested;
      if (target) scroller.scrollTop = Math.max(0, target.offsetTop - 16);
    }
    requestedPage.current = page;
    callbacks.current.onScale?.(geometry[(reportedPage.current ?? requested) - 1].scale);
    rememberAnchor();
  }, [geometry, page, rememberAnchor]);

  const onScroll = useCallback(() => {
    if (useAppStore.getState().reader.selection) readingSelectionChanged(null);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      rememberAnchor();
      const probe = scroller.scrollTop + Math.min(80, scroller.clientHeight / 5);
      const pages = [...scroller.querySelectorAll<HTMLElement>("[data-page-number]")];
      const target = pages.find(item => item.offsetTop + item.offsetHeight > probe) ?? pages.at(-1);
      const next = target ? Number(target.dataset.pageNumber) : null;
      if (next !== null && next !== reportedPage.current) {
        reportedPage.current = next;
        callbacks.current.onPageChange(next);
      }
    });
  }, [rememberAnchor]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = geometry[(reportedPage.current ?? page) - 1]?.scale ?? 1;
      callbacks.current.onZoom?.(stepZoom(current, event.deltaY < 0 ? 1 : -1));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => { scroller.removeEventListener("wheel", onWheel); };
  }, [geometry, page]);

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  if (error) return <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-accent-fail">PDF 打开失败：{error}</div>;
  return <div ref={scrollerRef} onScroll={onScroll} style={{ overflowAnchor: "none" }} className="relative min-h-0 flex-1 overflow-auto bg-bg-root p-4" data-testid="reader-scroller">
    {document ? <div className="flex min-w-full w-max flex-col items-center gap-4">
      {geometry.map((dimensions, index) => <PdfPageSlot key={index + 1} document={document} number={index + 1} dimensions={dimensions} scrollerRef={scrollerRef} initialPage={initialPage} highlights={highlights.filter(item => item.page === index + 1)} onScanned={onScanned} />)}
    </div> : <p className="py-2 text-xs text-text-faint">正在打开 PDF…</p>}
  </div>;
}

/** Keep every page's geometry in the scroll flow, painting only nearby pages. */
function PdfPageSlot({ document, number, dimensions, scrollerRef, initialPage, highlights, onScanned }: {
  document: LoadedPdf; number: number; dimensions: PageGeometry; scrollerRef: React.RefObject<HTMLDivElement | null>;
  initialPage: number; highlights: AnnotationView[]; onScanned?: (scanned: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(Math.abs(number - initialPage) <= 1);
  useEffect(() => {
    const element = ref.current;
    const root = scrollerRef.current;
    if (!element || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { root, rootMargin: `${root.clientHeight}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollerRef]);
  return <div ref={ref} data-page-number={number} className="relative shrink-0 bg-white shadow-lv2" style={{ width: dimensions.width, height: dimensions.height }}>
    {visible ? <PdfPage key={dimensions.scale} document={document} number={number} scale={dimensions.scale} highlights={highlights} onScanned={onScanned} /> : <p className="absolute inset-0 flex items-center justify-center text-xs text-text-faint">第 {number} 页</p>}
  </div>;
}

function PdfPage({ document, number, scale, highlights, onScanned }: {
  document: LoadedPdf; number: number; scale: number; highlights: AnnotationView[]; onScanned?: (scanned: boolean) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textTask: TextLayerBuilder | undefined;
    let pdfPage: PDFPageProxy | undefined;
    const canvas = canvasRef.current;
    async function paint() {
      pdfPage = await document.proxy.getPage(number);
      if (cancelled || !canvas) return;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (context) {
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
        await renderTask.promise;
      }
      if (cancelled || !textRef.current) return;
      if (number === 1 && onScanned) {
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        onScanned(content.items.length === 0);
      }
      // Global selection listeners share document lifetime, not a single page.
      textTask = new document.TextLayer({ pdfPage, abortSignal: document.selectionSignal });
      textRef.current.append(textTask.div);
      await textTask.render({ viewport, images: new document.runtime.TextLayerImages(0, new Float64Array(), viewport, () => canvas) });
      if (!cancelled) setReady(true);
    }
    void paint().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textTask?.cancel();
      pdfPage?.cleanup();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
  }, [document, number, scale, onScanned]);

  function captureSelection() {
    const pageEl = pageRef.current, textLayer = textRef.current, selection = window.getSelection();
    if (!pageEl || !textLayer || !selection || selection.rangeCount === 0 || selection.isCollapsed) { readingSelectionChanged(null); return; }
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.commonAncestorContainer)) { readingSelectionChanged(null); return; }
    const text = selection.toString().trim();
    const base = pageEl.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(rect => rect.width >= 1 && rect.height >= 1);
    if (!text || !rects.length) { readingSelectionChanged(null); return; }
    const full = textLayer.textContent ?? "", at = full.indexOf(text), first = rects[0];
    readingSelectionChanged({
      text, page: number,
      prefix: at > 0 ? full.slice(Math.max(0, at - 40), at) : "",
      suffix: at >= 0 ? full.slice(at + text.length, at + text.length + 40) : "",
      rects: rects.map(rect => ({ x: (rect.left - base.left) / base.width, y: (rect.top - base.top) / base.height, w: rect.width / base.width, h: rect.height / base.height })),
      x: first.left + first.width / 2, y: first.top,
    });
  }
  return <div ref={pageRef} onMouseUp={captureSelection} data-testid="pdf-page" data-pdf-page={number} data-rendered-scale={ready ? scale : undefined} aria-busy={!ready} className="relative h-full w-full" style={{ "--total-scale-factor": scale } as CSSProperties}>
    <canvas ref={canvasRef} className="block" />
    <div ref={textRef} data-testid="pdf-text-layer" />
    <div className="pointer-events-none absolute inset-0" aria-hidden data-testid="pdf-highlight-layer">
      {highlights.flatMap(item => item.rects.map((rect, index) => <div key={`${item.id}-${index}`} className={`absolute rounded-sm ${item.color === "yellow" ? "bg-yellow-300/45" : item.color === "green" ? "bg-green-300/45" : item.color === "blue" ? "bg-blue-300/45" : "bg-red-300/45"}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />))}
    </div>
    {error ? <p role="alert" className="absolute inset-x-0 top-2 p-2 text-xs text-accent-fail">{error}</p> : null}
  </div>;
}
