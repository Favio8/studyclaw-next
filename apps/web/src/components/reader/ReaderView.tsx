"use client";

/**
 * 辅助阅读视图（PRD 需求三，P2 MVP：数字 PDF + md/txt）。
 * 三区：资料树 | 阅读器（PdfCanvas / MarkdownReader）| 标注侧栏；
 * 划词浮层与 LLM 动作卡（解释/翻译，流式）覆盖在中区上。
 * 扫描件 OCR 文本层与 docx/xlsx/html 解析视图在 P2.5（依赖 MinerU）。
 */

import ConceptCardFill from "@/src/components/panel/ConceptCardFill";
import MarkdownView from "@/src/components/chat/MarkdownView";
import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Sparkles,
  StickyNote,
  X,
  FolderOpen,
  Maximize,
  Minimize,
  Plus,
  Minus,
} from "lucide-react";
import { isReaderEditable, stepZoom, type ReaderZoom } from "@/src/lib/readerZoom";
import { isModalOpen } from "@/src/lib/modalStack";
import MaterialTree from "@/src/components/reader/MaterialTree";
import ImageCanvas from "@/src/components/reader/ImageCanvas";
import PdfCanvas from "@/src/components/reader/PdfCanvas";
import ParsedView from "@/src/components/reader/ParsedView";
import MarkdownReader from "@/src/components/reader/MarkdownReader";
import AnnotationRail from "@/src/components/reader/AnnotationRail";
import SelectionPopover from "@/src/components/reader/SelectionPopover";
import DocumentOutline from "@/src/components/reader/DocumentOutline";
import { useAppStore } from "@/src/store/useAppStore";
import {
  readingCommitCard,
  readingContinueInChat,
  readingDismissAction,
  readingDismissCardDraft,
  readingOpen,
  readingSaveProgress,
} from "@/src/lib/readingFlow";
import { openSummaryPanel, runReadingSummary } from "@/src/lib/summaryFlow";
import SummaryPanel from "@/src/components/reader/SummaryPanel";

/** P3：划词建卡草稿确认面板（题干可编辑，确认后入池）。 */
function CardDraftPanel() {
  const draft = useAppStore((s) => s.reader.cardDraft);
  const task = draft?.task;
  // 新草稿到达时在渲染期同步题干（React 调锆模式，不用 effect）。
  const [question, setQuestion] = useState(() => (typeof task?.["question"] === "string" ? String(task["question"]) : ""));
  const [questionFor, setQuestionFor] = useState(task);
  if (questionFor !== task) {
    setQuestionFor(task);
    setQuestion(typeof task?.["question"] === "string" ? String(task["question"]) : "");
  }
  if (draft === null) return null;
  const ready = Object.keys(draft.task).length > 0 && !draft.busy;

  return (
    <div className="absolute bottom-4 left-1/2 z-20 w-[min(560px,calc(100%-48px))] -translate-x-1/2 rounded-2xl border border-border-line bg-bg-panel p-3 shadow-lv3" data-testid="card-draft-panel">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-text-primary">题卡草稿</span>
        <span className="truncate text-[11px] text-text-faint" title={draft.quote}>“{draft.quote.slice(0, 24)}”</span>
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={readingDismissCardDraft}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary"
        >
          <X size={13} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      {draft.busy ? (
        <p className="mt-2 text-[12px] text-text-muted">正在生成题卡草稿…</p>
      ) : draft.error !== null ? (
        <p role="alert" className="mt-2 text-[12px] leading-5 text-accent-fail">{draft.error}</p>
      ) : (
        <>
          <label className="mt-2 block text-[11px] text-text-faint" htmlFor="card-draft-question">题干（可编辑）</label>
          <textarea
            id="card-draft-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-border-line bg-bg-root px-2 py-1.5 text-[13px] leading-5 text-text-primary focus:border-accent-focus focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-text-faint">
              {String(draft.task["type"] ?? "concept")} · 难度 {String(draft.task["difficulty"] ?? 2)} · {String(draft.task["concept_id"] ?? "")}
            </span>
            <button
              type="button"
              disabled={!ready || question.trim() === ""}
              onClick={() => void readingCommitCard({ ...task, question: question.trim() })}
              className="ml-auto inline-flex h-7 items-center rounded-md bg-accent-focus px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-focus-hover disabled:opacity-40"
            >
              确认建卡
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 阅读动作结果卡（解释/翻译的流式输出）。 */
function ActionCard() {
  const action = useAppStore((s) => s.reader.action);
  if (action === null) return null;
  return (
    <div className="absolute bottom-4 left-1/2 z-20 w-[min(560px,calc(100%-48px))] -translate-x-1/2 rounded-2xl border border-border-line bg-bg-panel p-3 shadow-lv3" data-testid="reading-action-card">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-text-primary">{action.kind === "explain" ? "解释" : "翻译"}</span>
        {action.streaming ? <span className="stream-cursor text-accent-focus">█</span> : null}
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={readingDismissAction}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary"
        >
          <X size={13} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      {action.error !== null ? (
        <p role="alert" className="mt-1 text-[12px] leading-5 text-accent-fail">{action.error}</p>
      ) : (
        <div className="mt-1 max-h-[min(420px,50vh)] overflow-y-auto text-text-primary">
          {action.text === "" && action.streaming ? <p className="text-[13px] leading-6">正在生成…</p> : <MarkdownView content={action.text} compact modelOutput streaming={action.streaming} />}
        </div>
      )}
      {!action.streaming && action.text !== "" ? (
        <button
          type="button"
          onClick={() => void readingContinueInChat()}
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-accent-focus px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-focus-hover"
        >
          <MessageSquare size={12} strokeWidth={1.8} aria-hidden />
          就这段继续对话
        </button>
      ) : null}
    </div>
  );
}

export default function ReaderView({ focus = false, onFocusChange }: { focus?: boolean; onFocusChange?: (value: boolean) => void }) {
  const reader = useAppStore((s) => s.reader);
  const courseId = useAppStore((s) => s.activeCourseId);
  const [pageCount, setPageCount] = useState(0);
  const [textView, setTextView] = useState(false);
  const [textSource, setTextSource] = useState(reader.source);
  if (textSource !== reader.source) { setTextSource(reader.source); setTextView(false); setPageCount(0); }
  const [railOpen, setRailOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [zoom, setZoom] = useState<ReaderZoom>("width");
  const [scale, setScale] = useState(1);
  const displayScale = !textView && (reader.view === "pdf" || reader.view === "image") ? scale : typeof zoom === "number" ? zoom : 1;
  const textZoom = typeof zoom === "number" ? zoom : 1;
  const changeZoom = useCallback((direction: number) => setZoom(stepZoom(displayScale, direction)), [displayScale]);
  // 进入阅读活动时默认打开第一份 PDF（无则留空态由用户点选）。
  useEffect(() => {
    let alive = true;
    const context = useAppStore.getState();
    if (reader.source === null && courseId !== null) {
      void (async () => {
        const { api } = await import("@/src/lib/api");
        const payload = await api.courseFiles(courseId).catch(() => null);
        const now = useAppStore.getState();
        if (!alive || now.workspacePath !== context.workspacePath || now.courseGeneration !== context.courseGeneration || now.reader.source !== null) return;
        const firstPdf = (payload?.files ?? []).find((file) => String(file.relative).toLowerCase().endsWith(".pdf"));
        const first = firstPdf ?? (payload?.files ?? [])[0];
        if (first !== undefined) void readingOpen(String(first.relative));
      })();
    }
    return () => { alive = false; };
    // 仅在挂载时自动打开一次；之后由用户点选驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const gotoPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(pageCount === 0 ? page : pageCount, page));
    useAppStore.getState().setReader({ progress: { ...useAppStore.getState().reader.progress, page: clamped } });
    if (pageCount > 0) {
      void readingSaveProgress(clamped, Math.floor((clamped / pageCount) * 100));
    }
  }, [pageCount]);

  const locate = useCallback((page: number) => {
    useAppStore.getState().setReader({ progress: { ...useAppStore.getState().reader.progress, page } });
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isReaderEditable(event.target) || isModalOpen()) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if ((["PageDown", "PageUp", "ArrowRight", "ArrowLeft"].includes(event.key)) && (reader.view !== "pdf" || textView)) return;
      if (["+", "=", "-", "f", "F", "Escape", "PageDown", "PageUp", "ArrowRight", "ArrowLeft"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "+" || event.key === "=") changeZoom(1);
        else if (event.key === "-") changeZoom(-1);
        else if (event.key === "f" || event.key === "F") onFocusChange?.(!focus);
        else if (event.key === "Escape") { onFocusChange?.(false); if (!focus) { setRailOpen(false); setTreeOpen(false); } }
        else gotoPage(reader.progress.page + (["PageDown", "ArrowRight"].includes(event.key) ? 1 : -1));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [changeZoom, focus, onFocusChange, gotoPage, reader.progress.page, reader.view, textView]);

  if (courseId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <BookOpen size={22} strokeWidth={1.8} className="text-text-faint" aria-hidden />
        <p className="text-[13px] text-text-muted">先打开一个学习项目，即可精读它的资料。</p>
      </div>
    );
  }

  if (reader.loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-text-faint">正在打开资料…</div>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid="reader-view">
      {treeOpen && !focus ? <MaterialTree /> : null}
      {outlineOpen && !focus && reader.source ? <DocumentOutline key={reader.source} source={reader.source} onClose={() => setOutlineOpen(false)} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 阅读器工具条：页码 + 进度 */}
        <div data-testid="reader-toolbar" className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border-line px-3">
          <button type="button" aria-label="资料列表" aria-expanded={treeOpen && !focus} onClick={() => { onFocusChange?.(false); setTreeOpen(!treeOpen); }} className="p-1 text-text-muted"><FolderOpen size={16} /></button>
          <button type="button" aria-label="原文目录" aria-expanded={outlineOpen && !focus} disabled={!reader.source} onClick={() => { onFocusChange?.(false); setTreeOpen(false); setOutlineOpen(!outlineOpen); }} className="rounded px-2 py-1 text-xs text-text-muted hover:bg-bg-card">原文目录</button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted" title={reader.source ?? ""}>
            {reader.source ?? "未选择资料"}
          </span>
          {reader.view === "pdf" ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="上一页"
                title="上一页"
                disabled={reader.progress.page <= 1}
                onClick={() => gotoPage(reader.progress.page - 1)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
              >
                <ChevronLeft size={14} strokeWidth={1.8} aria-hidden />
              </button>
              <span className="text-[12px] text-text-faint">
                {reader.progress.page}{pageCount > 0 ? ` / ${pageCount}` : ""} · {reader.progress.percent}%
              </span>
              <button
                type="button"
                aria-label="下一页"
                title="下一页"
                disabled={pageCount > 0 && reader.progress.page >= pageCount}
                onClick={() => gotoPage(reader.progress.page + 1)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
              >
                <ChevronRight size={14} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          ) : null}
          <button type="button" aria-label="切换正文视图" aria-pressed={textView} onClick={() => setTextView(!textView)} className="rounded px-2 py-1 text-xs text-text-muted">{textView ? "原文" : "正文 / OCR"}</button>
          {reader.source ? <button
            type="button"
            aria-label="AI 概括"
            title="AI 概括（阅读前快速看重点）"
            onClick={() => { openSummaryPanel(); void runReadingSummary(false); }}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent-focus transition-colors hover:bg-bg-card"
          >
            <Sparkles size={13} strokeWidth={1.8} aria-hidden />
            AI 概括
          </button> : null}
          {reader.source ? <ConceptCardFill variant="toolbar" /> : null}
          <div className="flex items-center gap-1" aria-label="阅读缩放">
            <button type="button" aria-label="缩小" title="缩小（-）" onClick={() => changeZoom(-1)} className="p-1"><Minus size={15} /></button>
            <select aria-label="缩放模式" value={zoom} onChange={(event) => { const value = event.target.value; setZoom(value === "width" || value === "page" ? value : Number(value)); }} className="max-w-32 rounded border border-border-line bg-bg-panel px-1 py-1 text-xs">
              <option value="width">适合宽度 · {Math.round(displayScale * 100)}%</option>
              <option value="page">适合整页</option>
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, ...(typeof zoom === "number" && ![0.5,0.75,1,1.25,1.5,2,3,4].includes(zoom) ? [zoom] : [])].sort((a,b)=>a-b).map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
            </select>
            <button type="button" aria-label="放大" title="放大（+）" onClick={() => changeZoom(1)} className="p-1"><Plus size={15} /></button>
            <button type="button" aria-label={focus ? "退出专注阅读" : "专注阅读"} title="专注阅读（F）；退出（Esc）" onClick={() => onFocusChange?.(!focus)} className="p-1">{focus ? <Minimize size={15} /> : <Maximize size={15} />}</button>
          </div>
          {(<button
              type="button"
              aria-label="标注列表"
              aria-expanded={railOpen}
              title="标注列表"
              onClick={() => setRailOpen((open) => !open)}
              className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors ${railOpen ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}
            >
              <StickyNote size={13} strokeWidth={1.8} aria-hidden />
              标注 {reader.highlights.length}
            </button>
          )}
        </div>

        {reader.recovered ? (
          <p className="shrink-0 border-b border-accent-warn/30 bg-accent-warn/8 px-3 py-1.5 text-[11px] leading-5 text-accent-warn" role="status">
            标注文件此前已损坏，旧内容备份为 .bak-*，本次从空标注开始。
          </p>
        ) : null}
        {reader.error !== null ? (
          <p className="shrink-0 border-b border-accent-fail/25 bg-accent-fail/5 px-3 py-1.5 text-[11px] leading-5 text-accent-fail" role="alert">
            {reader.error}
          </p>
        ) : null}

        <div data-testid="reader-content" className="relative flex min-h-0 flex-1 flex-col">
        {reader.source === null ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <BookOpen size={22} strokeWidth={1.8} className="text-text-faint" aria-hidden />
            <p className="text-[13px] text-text-muted">从左侧资料树选一份文件开始精读。</p>
          </div>
        ) : textView ? (
          <ParsedView source={reader.source} zoom={textZoom} />
        ) : reader.view === "image" ? (
          <ImageCanvas key={reader.source} source={reader.source} zoom={zoom} onScale={setScale} onZoom={setZoom} />
        ) : reader.view === "pdf" ? (
          <PdfCanvas
            source={reader.source}
            page={reader.progress.page}
            highlights={reader.highlights}
            onPageCount={setPageCount}
            onPageChange={gotoPage}
            zoom={zoom}
            onScale={setScale}
            onZoom={setZoom}
          />
        ) : reader.view === "markdown" ? (
          <MarkdownReader source={reader.source} zoom={textZoom} />
        ) : (
          // 扫描件 PDF 与 docx/xlsx/html 等：解析视图（MinerU 产物）。
          <ParsedView source={reader.source} zoom={textZoom} />
        )}
        {railOpen && !focus ? <div data-testid="annotation-drawer" className="absolute right-0 bottom-0 top-0 z-20 shadow-lv3"><AnnotationRail onLocate={locate} /></div> : null}
        {reader.summary !== null ? <SummaryPanel /> : null}
        </div>
      </div>
      <SelectionPopover />
      <ActionCard />
      <CardDraftPanel />
    </div>
  );
}
