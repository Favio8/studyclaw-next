"use client";

/**
 * 思考链折叠行（v1.5：DSH ReasoningRow 复刻）。
 *
 * 行高 24px：[16px 图标] 标签（14px secondary）· 2×2 分隔点 · 摘要一行
 * ellipsis（tertiary，流式时取最后一行 = 最新思考）；默认折叠、整行可点；
 * 展开体缩进 22px、14px/24px、pre-wrap、tertiary 色。
 * 流式运行态带 DSH 同款扫光动画。
 */

import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

interface ThinkingFoldProps {
  thinking: string;
  thinkingMs?: number;
}

export default function ThinkingFold({ thinking, thinkingMs }: ThinkingFoldProps) {
  const [open, setOpen] = useState(false);
  const running = thinkingMs == null;
  const seconds = running ? null : thinkingMs / 1000;
  const label = running ? "思考中" : `已深度思考 (${seconds!.toFixed(1)}s)`;
  // 摘要 = 最新一行思考（DSH 流式摘要自动滚到末行）
  const summary = thinking.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

  return (
    <div className="ds-reasoning-row flex flex-col" data-state={running ? "running" : "ok"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-6 w-full items-center gap-1.5 overflow-hidden text-left"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[14px] leading-none text-text-faint">
          {open ? <ChevronDown size={14} strokeWidth={1.8} aria-hidden /> : <Sparkles size={14} strokeWidth={1.7} aria-hidden />}
        </span>
        <span className="shrink-0 text-sm text-text-muted">{label}</span>
        <span className="mx-1 h-0.5 w-0.5 shrink-0 rounded-[1px] bg-text-caption" />
        <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
          {summary}
        </span>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words py-1 pl-[22px] font-sans text-sm leading-6 text-text-faint">
          {thinking}
        </pre>
      )}
    </div>
  );
}
