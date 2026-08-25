"use client";

import { CircleHelp } from "lucide-react";

/**
 * 提问块 AskFold（v1.12，M-C 显式提问，ui_design_spec §2.3.1 / §4.6）。
 *
 * chat SSE `ask` 事件 → 消息卡在工具折叠块之后、正文之前渲染本块：
 * [❓ 16px] 标签 `导师提问 · 等待回答`（14px secondary）· 问题全文（tertiary pre-wrap）。
 * 默认展开、不可折叠（强提示等待学生输入）；`write_note` 不在此块展示（复用工具折叠块）。
 */

interface AskFoldProps {
  question: string;
}

export default function AskFold({ question }: AskFoldProps) {
  return (
    <div
      data-ask-fold=""
      className="flex flex-col gap-1 rounded-lg border border-border-line bg-bg-card/60 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[14px] leading-none">
          <CircleHelp size={14} strokeWidth={1.7} aria-hidden />
        </span>
        <span className="shrink-0 text-sm text-text-muted">导师提问 · 等待回答</span>
      </div>
      <p className="whitespace-pre-wrap pl-[22px] text-sm leading-5 text-text-primary">
        {question}
      </p>
    </div>
  );
}
