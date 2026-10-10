"use client";

/**
 * 解析视图（PRD P2.5）：docx/xlsx/html 与扫描件 PDF 的 MinerU Markdown 产物。
 * 与 MarkdownReader 的区别：内容来自构建期缓存而非源文件，顶部有"解析视图"
 * 横幅说明引擎与档位；选区交互同一套（quote 锚退化为页级）。
 *
 * 说明：产物是 Markdown（无页边界），因此扫描件 PDF 这里按文档流阅读，
 * 不做逐页 OCR 文本层叠加——那需要 MinerU 的 Content List 分页产物，
 * 留待后续迭代。
 */

import { useEffect, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import MarkdownView from "@/src/components/chat/MarkdownView";
import { api } from "@/src/lib/api";
import { readingSelectionChanged } from "@/src/lib/readingFlow";
import type { ReaderSelection } from "@/src/store/useAppStore";

export default function ParsedView({ source }: { source: string }) {
  const [markdown, setMarkdown] = useState<string>("");
  const [meta, setMeta] = useState<{ engine: string | null; tier: string | null }>({ engine: null, tier: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.readingParsed(source).then((payload) => {
      if (!alive) return;
      if (payload.available) {
        setMarkdown(payload.markdown);
        setMeta({ engine: payload.engine, tier: payload.tier });
        setNotice(null);
        setError(null);
      } else {
        setMarkdown("");
        setNotice(payload.reason ?? "解析产物暂不可用");
      }
    }).catch((exc: unknown) => {
      if (alive) setError(exc instanceof Error ? exc.message : String(exc));
    });
    return () => { alive = false; };
  }, [source]);

  function captureSelection() {
    const body = bodyRef.current;
    if (body === null) return;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
      readingSelectionChanged(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) {
      readingSelectionChanged(null);
      return;
    }
    const text = selection.toString().trim();
    if (text === "") {
      readingSelectionChanged(null);
      return;
    }
    const full = body.textContent ?? "";
    const at = full.indexOf(text);
    const rect = range.getClientRects()[0];
    const next: ReaderSelection = {
      text,
      prefix: at > 0 ? full.slice(Math.max(0, at - 40), at) : "",
      suffix: at >= 0 ? full.slice(at + text.length, at + text.length + 40) : "",
      page: 1,
      rects: [],
      x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
      y: rect?.top ?? 0,
    };
    readingSelectionChanged(next);
  }

  if (error !== null) {
    return <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-accent-fail" role="alert">解析视图读取失败：{error}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-line bg-bg-card/50 px-4 py-1.5 text-[11px] text-text-muted">
        <FileSearch size={13} strokeWidth={1.8} aria-hidden />
        <span>解析视图</span>
        {meta.engine !== null ? <span className="text-text-faint">· {meta.engine}{meta.tier ? ` / ${meta.tier}` : ""}</span> : null}
        <span className="ml-auto truncate text-text-faint" title={source}>{source}</span>
      </div>
      {notice !== null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <FileSearch size={22} strokeWidth={1.8} className="text-text-faint" aria-hidden />
          <p className="max-w-[420px] text-[13px] leading-6 text-text-muted">{notice}</p>
        </div>
      ) : (
        <div ref={bodyRef} onMouseUp={captureSelection} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <MarkdownView content={markdown} />
        </div>
      )}
    </div>
  );
}
