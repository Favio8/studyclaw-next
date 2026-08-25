"use client";

/**
 * 工具调用折叠块（v1.10，DSH tool view 复刻；ui_design_spec §2.3）。
 *
 * 视觉对齐 ThinkingFold：行高 24px = [🛠 16px 图标] `工具调用 · N 次`
 * （14px secondary）· 分隔点 · 摘要一行 ellipsis（tertiary，取最后一条工具的
 * 摘要 = 流式时最新动态）；默认折叠、整行可点。展开体缩进 22px：每条工具一行 =
 * 工具名（mono/13px）+ 状态徽标（success 绿 / degraded 琥珀 / rejected 红）+
 * 耗时 + 参数摘要 + 结果摘要；rejected/degraded 行标注 error 原因。
 *
 * **工具结果只进本折叠块，绝不渲染进 markdown 正文**（不污染正文流）。
 */

import { useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import type { ToolCallView } from "@/src/types/api";

interface ToolFoldProps {
  tools: ToolCallView[];
}

const STATUS_LABEL: Record<ToolCallView["status"], string> = {
  success: "成功",
  degraded: "降级",
  rejected: "拒绝",
};

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export default function ToolFold({ tools }: ToolFoldProps) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1];
  const summary = last?.summary ?? "";
  const label = `工具调用 · ${tools.length} 次`;

  return (
    <div className="flex flex-col" data-tool-fold="">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-6 w-full items-center gap-1.5 overflow-hidden text-left"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[14px] leading-none text-text-faint">
          {open ? <ChevronDown size={14} strokeWidth={1.8} aria-hidden /> : <Wrench size={14} strokeWidth={1.7} aria-hidden />}
        </span>
        <span className="shrink-0 text-sm text-text-muted">{label}</span>
        <span className="mx-1 h-0.5 w-0.5 shrink-0 rounded-[1px] bg-text-caption" />
        <span className="min-w-0 flex-1 truncate text-sm text-text-faint">
          {summary}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 py-1 pl-[22px]">
          {tools.map((tool, index) => (
            <div
              key={`${tool.name}-${index}`}
              className="flex flex-col gap-0.5"
              data-tool-status={tool.status}
            >
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
                <span className="shrink-0 font-mono text-text-primary">
                  {tool.name}
                </span>
                <span
                  className={`shrink-0 rounded bg-bg-card px-1 text-[11px] ${
                    tool.status === "success"
                      ? "text-accent-pass"
                      : tool.status === "degraded"
                        ? "text-accent-warn"
                        : "text-accent-fail"
                  }`}
                >
                  {STATUS_LABEL[tool.status]}
                </span>
                <span className="shrink-0 text-[12px] text-text-faint">
                  {tool.durationMs != null ? `${Math.round(tool.durationMs)}ms` : ""}
                </span>
              </div>
              <div className="truncate text-sm text-text-faint">
                参数 {formatArgs(tool.args)}
              </div>
              <div className="text-sm leading-5 text-text-faint">
                结果 {tool.summary}
              </div>
              {tool.error ? (
                <div className="text-sm leading-5 text-accent-fail">
                  {tool.error}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
