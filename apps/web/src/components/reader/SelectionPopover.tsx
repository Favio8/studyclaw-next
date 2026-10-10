"use client";

/**
 * 划词浮层（PRD 需求三）：选中文本后弹出的动作——四种颜色高亮、翻译、
 * 解释、建卡。非模态（z-20~30，低于一切对话框），不进 modalStack。
 */

import { Languages, PlusSquare, Sparkles } from "lucide-react";
import { useAppStore } from "@/src/store/useAppStore";
import { readingAddHighlight, readingDraftCard, readingRunAction } from "@/src/lib/readingFlow";
import type { AnnotationView } from "@/src/types/api";

const COLORS: Array<{ value: AnnotationView["color"]; label: string; className: string }> = [
  { value: "yellow", label: "黄", className: "bg-yellow-300" },
  { value: "green", label: "绿", className: "bg-green-300" },
  { value: "blue", label: "蓝", className: "bg-blue-300" },
  { value: "red", label: "红", className: "bg-red-300" },
];

export default function SelectionPopover() {
  const selection = useAppStore((s) => s.reader.selection);
  const courseId = useAppStore((s) => s.activeCourseId);
  if (selection === null) return null;

  const left = Math.max(8, Math.min(window.innerWidth - 300, selection.x - 140));
  const top = Math.max(8, selection.y - 44);

  return (
    <div
      role="dialog"
      aria-label="划词操作"
      data-testid="selection-popover"
      className="fixed z-30 flex items-center gap-1 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3"
      style={{ left, top }}
    >
      {COLORS.map((color) => (
        <button
          key={color.value}
          type="button"
          title={`高亮（${color.label}）`}
          aria-label={`高亮（${color.label}）`}
          onClick={() => void readingAddHighlight(color.value)}
          className={`h-6 w-6 rounded-md border border-border-line transition-transform hover:scale-110 ${color.className}`}
        />
      ))}
      <span aria-hidden className="h-5 w-px shrink-0 bg-border-faint" />
      <button
        type="button"
        title="翻译选中文本（中英互译）"
        onClick={() => void readingRunAction("translate")}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-text-primary transition-colors hover:bg-bg-card"
      >
        <Languages size={13} strokeWidth={1.8} aria-hidden />
        翻译
      </button>
      <button
        type="button"
        title="结合课程状态解释选中文本"
        onClick={() => void readingRunAction("explain")}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-accent-focus transition-colors hover:bg-bg-card"
      >
        <Sparkles size={13} strokeWidth={1.8} aria-hidden />
        解释
      </button>
      <button
        type="button"
        disabled={courseId === null}
        title="把选中内容生成题卡草稿（确认后入池）"
        onClick={() => void readingDraftCard()}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
      >
        <PlusSquare size={13} strokeWidth={1.8} aria-hidden />
        建卡
      </button>
    </div>
  );
}
