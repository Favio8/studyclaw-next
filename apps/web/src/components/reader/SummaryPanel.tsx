"use client";

/**
 * F3：AI 概括结果面板（宽屏为阅读区侧面板，窄屏为抽屉式覆盖）。
 *
 * 显示实际处理范围、部分完成/错误/停止状态；关键事实带出处，点击返回原文
 * 对应位置；支持保存到笔记与发送到对话。关闭面板即结束生成。
 */

import { BookOpen, Loader2, MessageSquare, RefreshCw, Square, StickyNote, X } from "lucide-react";
import {
  closeSummaryPanel,
  runReadingSummary,
  saveSummaryToNotes,
  sendSummaryToChat,
  setSummaryScope,
  stopReadingSummary,
  summaryToMarkdown,
} from "@/src/lib/summaryFlow";
import { readingOpenAt } from "@/src/lib/readingFlow";
import { useAppStore } from "@/src/store/useAppStore";

export default function SummaryPanel() {
  const summary = useAppStore((s) => s.reader.summary);
  const source = useAppStore((s) => s.reader.source);
  const setClipboard = useAppStore((s) => s.flashStatusBanner);
  if (summary === null || source === null) return null;
  const result = summary.result;

  async function copy() {
    if (result === null) return;
    if (!navigator.clipboard) { setClipboard("剪贴板不可用"); return; }
    await navigator.clipboard.writeText(summaryToMarkdown(result)).then(
      () => setClipboard("✓ 已复制概括到剪贴板"),
      () => setClipboard("复制失败"),
    );
  }

  return (
    <aside
      data-testid="summary-panel"
      className="absolute inset-y-0 right-0 z-30 flex w-[min(420px,100%)] shrink-0 flex-col border-l border-border-line bg-bg-panel shadow-lv3"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-line px-3 py-2">
        <BookOpen size={14} strokeWidth={1.8} className="text-accent-focus" aria-hidden />
        <span className="text-[13px] font-medium text-text-primary">AI 概括</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-text-faint" title={source}>
          {result?.scope === "chapter" ? `当前章节${result.chapterTitle ? ` · ${result.chapterTitle}` : ""}` : "当前资料"}
          {result !== null ? ` · ${result.model}` : ""}
        </span>
        <button type="button" aria-label="关闭概括" title="关闭" onClick={closeSummaryPanel} className="flex h-6 w-6 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary">
          <X size={13} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-line px-3 py-2">
        <select
          aria-label="概括范围"
          value={summary.scope}
          onChange={(event) => setSummaryScope(event.target.value === "chapter" ? "chapter" : "document")}
          className="rounded border border-border-line bg-bg-root px-1.5 py-1 text-[12px] text-text-primary"
        >
          <option value="document">当前资料</option>
          <option value="chapter">当前章节</option>
        </select>
        {summary.streaming ? (
          <button type="button" onClick={stopReadingSummary} className="inline-flex h-7 items-center gap-1 rounded-md border border-border-line px-2 text-[12px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary">
            <Square size={11} strokeWidth={2} aria-hidden />
            停止
          </button>
        ) : (
          <button type="button" onClick={() => void runReadingSummary(result !== null && result.coverage.complete)} className="inline-flex h-7 items-center gap-1 rounded-md border border-border-line px-2 text-[12px] text-accent-focus">
            <RefreshCw size={12} strokeWidth={1.8} aria-hidden />
            {result === null ? "生成" : result.coverage.complete ? "重新生成" : "补生成"}
          </button>
        )}
        {summary.streaming ? (
          <span role="status" className="inline-flex min-w-0 items-center gap-1 text-[11px] text-text-muted">
            <Loader2 size={11} strokeWidth={1.8} className="animate-spin" aria-hidden />
            <span className="truncate">{summary.phase}{summary.progress ? ` · ${summary.progress.current}/${summary.progress.total}` : ""}</span>
          </span>
        ) : summary.phase !== "" ? (
          <span className="text-[11px] text-text-faint">{summary.phase}</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {summary.error !== null ? (
          <p role="alert" className="rounded-lg border border-accent-fail/30 bg-accent-fail/5 p-2 text-[12px] leading-5 text-accent-fail">{summary.error}</p>
        ) : null}

        {result !== null ? (
          <>
            <p className="mb-2 text-[11px] leading-4 text-text-faint">
              覆盖：正文 {result.coverage.processed}/{result.coverage.total} 块 ·{" "}
              {result.coverage.complete ? "已完成" : "部分完成"}
              {result.range !== null ? ` · 第 ${result.range.startPage}–${result.range.endPage} 页` : ""}
              {result.fromCache ? " · 载入缓存" : ""}
            </p>
            {!result.coverage.complete && result.coverage.excluded.length > 0 ? (
              <ul className="mb-2 space-y-0.5 rounded-lg border border-accent-warn/30 bg-accent-warn/5 p-2 text-[11px] leading-4 text-accent-warn">
                {result.coverage.excluded.map((item, index) => <li key={index}>未覆盖：{item}</li>)}
              </ul>
            ) : null}

            <section className="mb-3">
              <h4 className="mb-1 text-[12px] font-medium text-text-primary">一句话概览</h4>
              <p className="text-[13px] leading-6 text-text-secondary">{result.overview}</p>
            </section>

            {result.points.length > 0 ? (
              <section className="mb-3">
                <h4 className="mb-1 text-[12px] font-medium text-text-primary">核心要点</h4>
                <ol className="space-y-1.5">
                  {result.points.map((point, index) => (
                    <li key={index} className="rounded-lg bg-bg-root p-2">
                      <div className="text-[12px] leading-5 text-text-secondary">{point.text}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {point.evidence.map((evidence, evidenceIndex) => (
                          <button
                            key={evidenceIndex}
                            type="button"
                            onClick={() => void readingOpenAt(source, evidence.page)}
                            className="rounded border border-border-line px-1.5 py-0.5 text-[10px] text-accent-focus hover:bg-bg-card"
                            title={evidence.quote}
                          >
                            查看原文：第 {evidence.page} 页
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {result.concepts.length > 0 ? (
              <section className="mb-3">
                <h4 className="mb-1 text-[12px] font-medium text-text-primary">关键概念</h4>
                <ul className="space-y-1.5">
                  {result.concepts.map((concept, index) => (
                    <li key={index} className="rounded-lg bg-bg-root p-2">
                      <span className="text-[12px] font-medium text-text-primary">{concept.name}</span>
                      <p className="text-[12px] leading-5 text-text-secondary">{concept.explanation}</p>
                      {concept.evidence[0] !== undefined ? (
                        <button type="button" onClick={() => void readingOpenAt(source, concept.evidence[0]!.page)} className="text-[10px] text-accent-focus">
                          查看原文：第 {concept.evidence[0]!.page} 页
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {result.suggestions.length > 0 ? (
              <section className="mb-3">
                <h4 className="mb-1 text-[12px] font-medium text-text-primary">建议先读 <span className="font-normal text-text-faint">（AI 阅读建议）</span></h4>
                <ul className="space-y-1">
                  {result.suggestions.map((suggestion, index) => (
                    <li key={index} className="flex items-start gap-2 text-[12px] leading-5 text-text-secondary">
                      <button type="button" onClick={() => void readingOpenAt(source, suggestion.page)} className="shrink-0 text-accent-focus">→ 第 {suggestion.page} 页</button>
                      <span className="min-w-0"><span className="text-text-primary">{suggestion.label}</span> · {suggestion.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : summary.streaming ? (
          <p className="text-[12px] text-text-muted">正在生成概括，长文需要分段处理，请稍候…</p>
        ) : null}
      </div>

      {result !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border-line px-3 py-2">
          <button type="button" onClick={() => void saveSummaryToNotes()} className="inline-flex h-7 items-center gap-1 rounded-md border border-border-line px-2 text-[12px] text-text-muted transition-colors hover:text-text-primary">
            <StickyNote size={12} strokeWidth={1.8} aria-hidden />
            保存到笔记
          </button>
          <button type="button" onClick={sendSummaryToChat} className="inline-flex h-7 items-center gap-1 rounded-md border border-border-line px-2 text-[12px] text-text-muted transition-colors hover:text-text-primary">
            <MessageSquare size={12} strokeWidth={1.8} aria-hidden />
            发送到对话
          </button>
          <button type="button" onClick={() => void copy()} className="ml-auto text-[11px] text-text-faint transition-colors hover:text-text-muted">复制</button>
        </div>
      ) : null}
    </aside>
  );
}
