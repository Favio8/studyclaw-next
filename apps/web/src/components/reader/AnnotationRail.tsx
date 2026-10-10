"use client";

/**
 * 标注侧栏（PRD 需求三）：当前资料的划线/批注列表 + 导出。
 * MVP 只做本资料的标注（概念关联与「我的痕迹」在 P3）。
 */

import { ClipboardCopy, Trash2 } from "lucide-react";
import { useAppStore } from "@/src/store/useAppStore";
import { readingExportAnnotations, readingRemoveHighlight } from "@/src/lib/readingFlow";

const COLOR_LABEL: Record<string, string> = {
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  red: "红",
};

export default function AnnotationRail({ onLocate }: { onLocate: (page: number) => void }) {
  const reader = useAppStore((s) => s.reader);
  const highlights = reader.highlights;

  return (
    <div className="flex h-full w-[240px] shrink-0 flex-col border-l border-border-line bg-bg-root">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-line px-3">
        <span className="text-[12px] font-medium text-text-primary">标注 {highlights.length}</span>
        <button
          type="button"
          title="导出为 Markdown 并复制"
          onClick={() => void readingExportAnnotations()}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
        >
          <ClipboardCopy size={12} strokeWidth={1.8} aria-hidden />
          导出
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {highlights.length === 0 ? (
          <p className="px-1 py-3 text-[12px] leading-5 text-text-faint">
            选中文本即可高亮、翻译或解释；标注保存在课程目录的 .studyclaw/annotations.json。
          </p>
        ) : null}
        {[...highlights].reverse().map((item) => (
          <div key={item.id} className="group mb-1.5 rounded-lg border border-border-line bg-bg-panel p-2">
            <button
              type="button"
              onClick={() => onLocate(item.page)}
              className="block w-full text-left"
              title="跳到这一页"
            >
              <span className="text-[10px] text-text-faint">第 {item.page} 页 · {COLOR_LABEL[item.color] ?? item.color}</span>
              <span className="mt-0.5 block text-[12px] leading-5 text-text-primary">{item.quote.text || "（区域标注）"}</span>
              {item.comment !== "" ? <span className="mt-0.5 block text-[11px] leading-5 text-text-muted">{item.comment}</span> : null}
            </button>
            <button
              type="button"
              aria-label={`删除标注 ${item.quote.text.slice(0, 12)}`}
              title="删除标注"
              onClick={() => void readingRemoveHighlight(item.id)}
              className="mt-1 hidden h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-faint transition-colors hover:bg-accent-fail/10 hover:text-accent-fail group-hover:inline-flex"
            >
              <Trash2 size={11} strokeWidth={1.8} aria-hidden />
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
