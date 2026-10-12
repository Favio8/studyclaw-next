"use client";

/**
 * Markdown/纯文本阅读器（PRD 需求三）：md/txt 资料直接渲染，选区走同一套
 * 划词浮层（PDF 走 PdfCanvas）。内容经 /api/reading.file 同类通道按字节读
 * 取会引入鉴权复杂度——md/txt 走 RPC 更简单，这里直接用 courses.files 的
 * 相对路径由 Host 的 read_source 语义读取。
 */

import { useEffect, useRef, useState } from "react";
import MarkdownView from "@/src/components/chat/MarkdownView";
import { api } from "@/src/lib/api";
import { readingSelectionChanged } from "@/src/lib/readingFlow";
import type { ReaderSelection } from "@/src/store/useAppStore";

export default function MarkdownReader({ source, zoom = 1 }: { source: string; zoom?: number }) {
  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    // 复用 chat 的文件上下文读取通道（鉴权/路径守卫已在 Host 侧）。
    void api.readingText(source).then((payload) => {
      if (!alive) return;
      setText(payload.text);
      setError(null);
    }).catch((exc: unknown) => {
      if (!alive) return;
      setText("");
      setError(exc instanceof Error ? exc.message : String(exc));
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
    const selected = selection.toString().trim();
    if (selected === "") {
      readingSelectionChanged(null);
      return;
    }
    const full = body.textContent ?? "";
    const at = full.indexOf(selected);
    const rect = range.getClientRects()[0];
    const next: ReaderSelection = {
      text: selected,
      prefix: at > 0 ? full.slice(Math.max(0, at - 40), at) : "",
      suffix: at >= 0 ? full.slice(at + selected.length, at + selected.length + 40) : "",
      page: 1,
      rects: [{ x: 0, y: 0, w: 0, h: 0 }],
      x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
      y: rect?.top ?? 0,
    };
    readingSelectionChanged(next);
  }

  if (error !== null) {
    return <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-accent-fail" role="alert">读取失败：{error}</div>;
  }

  return (
    <div ref={bodyRef} onMouseUp={captureSelection} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div style={{ zoom }}><MarkdownView content={text} /></div>
    </div>
  );
}
