"use client";

/**
 * 辅助阅读视图（PRD 需求三，P2 MVP：数字 PDF + md/txt）。
 * 三区：资料树 | 阅读器（PdfCanvas / MarkdownReader）| 标注侧栏；
 * 划词浮层与 LLM 动作卡（解释/翻译，流式）覆盖在中区上。
 * 扫描件 OCR 文本层与 docx/xlsx/html 解析视图在 P2.5（依赖 MinerU）。
 */

import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, MessageSquare, X } from "lucide-react";
import MaterialTree from "@/src/components/reader/MaterialTree";
import PdfCanvas from "@/src/components/reader/PdfCanvas";
import MarkdownReader from "@/src/components/reader/MarkdownReader";
import AnnotationRail from "@/src/components/reader/AnnotationRail";
import SelectionPopover from "@/src/components/reader/SelectionPopover";
import { useAppStore } from "@/src/store/useAppStore";
import {
  readingContinueInChat,
  readingDismissAction,
  readingOpen,
  readingSaveProgress,
} from "@/src/lib/readingFlow";

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
        <p className="mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap text-[13px] leading-6 text-text-primary">
          {action.text === "" && action.streaming ? "正在生成…" : action.text}
        </p>
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

export default function ReaderView() {
  const reader = useAppStore((s) => s.reader);
  const courseId = useAppStore((s) => s.activeCourseId);
  const [pageCount, setPageCount] = useState(0);

  // 进入阅读活动时默认打开第一份 PDF（无则留空态由用户点选）。
  useEffect(() => {
    if (reader.source === null && courseId !== null) {
      void (async () => {
        const { api } = await import("@/src/lib/api");
        const payload = await api.courseFiles(courseId).catch(() => null);
        const firstPdf = (payload?.files ?? []).find((file) => String(file.relative).toLowerCase().endsWith(".pdf"));
        const first = firstPdf ?? (payload?.files ?? [])[0];
        if (first !== undefined) void readingOpen(String(first.relative));
      })();
    }
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

  // 点击页内高亮块 → 跳到该标注所在页（id → page）。
  const locateHighlight = useCallback((id: string) => {
    const hit = useAppStore.getState().reader.highlights.find((item) => item.id === id);
    if (hit !== undefined) locate(hit.page);
  }, [locate]);

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
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <MaterialTree />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 阅读器工具条：页码 + 进度 */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-line px-3">
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

        {reader.source === null ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <BookOpen size={22} strokeWidth={1.8} className="text-text-faint" aria-hidden />
            <p className="text-[13px] text-text-muted">从左侧资料树选一份文件开始精读。</p>
          </div>
        ) : reader.view === "pdf" ? (
          <PdfCanvas
            source={reader.source}
            page={reader.progress.page}
            highlights={reader.highlights}
            onPageCount={setPageCount}
            onPageChange={gotoPage}
            onHighlightClick={locateHighlight}
          />
        ) : reader.view === "markdown" ? (
          <MarkdownReader source={reader.source} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <BookOpen size={22} strokeWidth={1.8} className="text-text-faint" aria-hidden />
            <p className="text-[13px] leading-6 text-text-muted">
              该格式暂不支持直接阅读（当前支持 PDF 与 Markdown/纯文本）。
              <br />
               docx/xlsx/html 的解析视图将随 MinerU 接入后提供。
            </p>
          </div>
        )}
      </div>
      <AnnotationRail onLocate={locate} />
      <SelectionPopover />
      <ActionCard />
    </div>
  );
}
