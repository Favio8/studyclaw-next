"use client";

/**
 * 资料树（PRD 需求三）：当前课程 sources/ 下的文件列表，点击开读。
 * 数据复用输入框 @ 引用同款的 courses.files RPC。
 */

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import { readingOpen } from "@/src/lib/readingFlow";

export default function MaterialTree() {
  const courseId = useAppStore((s) => s.activeCourseId);
  const activeSource = useAppStore((s) => s.reader.source);
  const progressByFile = useAppStore((s) => s.reader.progress);
  const [files, setFiles] = useState<Array<{ relative: string; supported: boolean }>>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!courseId) return;
    let alive = true;
    void api.courseFiles(courseId).then((payload) => {
      if (!alive) return;
      const list = (payload.files ?? []).map((file) => ({
        relative: String(file.relative),
        supported: file.supported !== false,
      }));
      setFiles(list);
    }).catch(() => setFiles([]));
    return () => { alive = false; };
  }, [courseId]);

  const shown = files.filter((file) => file.relative.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="flex h-full w-[220px] shrink-0 flex-col border-r border-border-line bg-bg-root">
      <div className="shrink-0 border-b border-border-line p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索资料"
          aria-label="搜索资料"
          className="h-8 w-full rounded-lg border border-border-line bg-bg-panel px-2 text-[12px] text-text-primary placeholder:text-text-faint focus:border-accent-focus focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-text-faint">没有匹配的资料文件</p>
        ) : null}
        {shown.map((file) => {
          const active = file.relative === activeSource;
          return (
            <button
              key={file.relative}
              type="button"
              title={file.relative}
              onClick={() => void readingOpen(file.relative)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${active ? "bg-bg-card text-accent-focus" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}
            >
              <FileText size={13} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.relative.split("/").pop()}</span>
              {file.relative === activeSource && progressByFile.percent > 0 ? (
                <span className="shrink-0 text-[10px] text-text-faint">{progressByFile.percent}%</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
