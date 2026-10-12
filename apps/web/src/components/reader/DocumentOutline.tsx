"use client";

import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { api } from "@/src/lib/api";
import { readingOpenAt } from "@/src/lib/readingFlow";
import { useAppStore } from "@/src/store/useAppStore";

const translations = new Map<string, Promise<Map<number, string>>>();
const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Locate a heading in real page text; unknown pages remain unlinked. */
export function headingPage(title: string, blocks: Array<{ page: number; text: string }>): number | null {
  const needle = normalized(title);
  for (const block of blocks) {
    const lines = block.text.split(/\r?\n/).map(line => line.trim().replace(/^(?:[IVX]+|\d+(?:\.\d+)*|[A-Z])[.)]\s+/, ""));
    for (let index = 0; index < lines.length; index++) {
      for (let length = 1; length <= 3; length++) {
        if (normalized(lines.slice(index, index + length).join(" ")) === needle) return block.page;
      }
    }
  }
  return null;
}

async function translateTitles(key: string, source: string, titles: string[]): Promise<Map<number, string>> {
  let pending = translations.get(key);
  if (!pending) {
    pending = (async () => {
      let text = "";
      for await (const frame of api.readingTranslate(source, titles.map((title, index) => `${index + 1}. ${title}`).join("\n"))) {
        if (frame.event === "token") text += frame.data.delta ?? "";
        if (frame.event === "error") throw new Error(frame.data.message ?? "目录翻译失败");
      }
      const result = new Map<number, string>();
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(\d+)[.)、]\s*(.+)$/.exec(line);
        if (match && /[\u4e00-\u9fff]/.test(match[2])) result.set(Number(match[1]) - 1, match[2]);
      }
      return result;
    })();
    translations.set(key, pending);
    void pending.catch(() => translations.delete(key));
  }
  return pending;
}

export default function DocumentOutline({ source, onClose }: { source: string; onClose: () => void }) {
  const courseId = useAppStore((state) => state.activeCourseId);
  const workspacePath = useAppStore((state) => state.workspacePath);
  const [rows, setRows] = useState<Array<{ title: string; label?: string; page: number | null }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!courseId) return;
    let alive = true;
    void (async () => {
      const [syllabus, parsed] = await Promise.all([api.syllabus(courseId), api.readingParsed(source)]);
      if (!alive) return;
      const titles = (syllabus.document_outline ?? []).filter(item => (!item.source || basename(item.source) === basename(source)) && normalized(item.title) !== normalized(basename(source).replace(/\.[^.]+$/, ""))).map(item => item.title);
      const located = titles.map(title => ({ title, page: headingPage(title, parsed.blocks ?? []) }));
      setRows(located);
      if (titles.length && titles.some(title => !/[\u4e00-\u9fff]/.test(title))) {
        const labels = await translateTitles(JSON.stringify([workspacePath, courseId, source, titles]), source, titles);
        if (alive) setRows(located.map((row, index) => ({ ...row, label: labels.get(index) })));
      }
    })().catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [courseId, workspacePath, source]);
  return <aside data-testid="document-outline" className="flex w-[280px] shrink-0 flex-col border-r border-border-line bg-bg-root">
    <div className="flex items-center gap-2 border-b border-border-line p-3 text-sm"><BookOpen size={15} aria-hidden /><span className="flex-1">原文目录</span><button type="button" aria-label="关闭原文目录" onClick={onClose}><X size={15} /></button></div>
    <p className="px-3 pt-2 text-[11px] text-text-faint">{basename(source)} · 点击页码回到原文</p>
    <div className="min-h-0 flex-1 overflow-auto p-2">
      {rows === null && !error ? <p className="p-2 text-xs text-text-faint">正在读取目录…</p> : null}
      {rows?.length === 0 ? <p className="p-2 text-xs text-text-faint">这份资料暂无章节目录。</p> : null}
      {rows?.map((row, index) => <button key={index} type="button" disabled={row.page === null} onClick={() => { if (row.page !== null) void readingOpenAt(source, row.page); }} className="mb-1 w-full rounded-lg p-2 text-left hover:bg-bg-card disabled:cursor-default">
        <span className="block text-xs leading-5 text-text-primary">{row.label ?? row.title}</span>
        {row.label ? <span className="block text-[10px] leading-4 text-text-faint">{row.title}</span> : null}
        <span className="text-[10px] text-accent-focus">{row.page === null ? "未定位页码" : `第 ${row.page} 页`}</span>
      </button>)}
      {error ? <p role="status" className="p-2 text-xs text-text-muted">{error}</p> : null}
    </div>
  </aside>;
}
