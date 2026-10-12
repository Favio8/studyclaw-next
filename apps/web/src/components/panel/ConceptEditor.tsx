"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/src/lib/api";
import { refreshPanelData } from "@/src/lib/panelData";
import { readingOpenAt } from "@/src/lib/readingFlow";
import { registerConceptDialog } from "@/src/lib/conceptDialog";
import { loadConceptCardStatus } from "@/src/lib/conceptFillFlow";
import { useAppStore } from "@/src/store/useAppStore";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import ConceptCardFill from "@/src/components/panel/ConceptCardFill";
import type { SemanticDraft } from "@/src/types/api";
import MarkdownView from "@/src/components/chat/MarkdownView";

/**
 * F2：概念提炼入口 + 补题入口（覆盖统计/前置条件/进度/结果）。
 * 弹层打开动作注册到 conceptDialog，供补题前置条件与新手引导直达。
 */
export default function ConceptEditor({ onApplied }: { onApplied?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    registerConceptDialog(() => setOpen(true));
    return () => registerConceptDialog(null);
  }, []);
  return <>
    <ConceptCardFill />
    {open ? createPortal(<ConceptDialog onClose={() => setOpen(false)} onApplied={onApplied} />, document.body) : null}
  </>;
}

function ConceptDialog({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SemanticDraft | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const context = useRef(useAppStore.getState());
  const current = () => {
    const state = useAppStore.getState();
    return state.workspacePath === context.current.workspacePath && state.courseGeneration === context.current.courseGeneration && state.activeCourseId === context.current.activeCourseId;
  };
  useFocusTrap({ containerRef: container, onEscape: () => { if (!busy) onClose(); } });
  const generate = async () => {
    const courseId = context.current.activeCourseId;
    if (!courseId) return;
    setBusy(true); setError(null);
    try {
      const files = (await api.courseFiles(courseId)).files.map(file => String(file.relative));
      if (!current()) return;
      const result = await api.conceptDraft(courseId, files);
      if (!current()) return;
      setDraft(result);
      setNames(Object.fromEntries(result.concepts.map(item => [item.id, item.name])));
      setSelected(new Set(result.concepts.map(item => item.id)));
    } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!draft || !context.current.activeCourseId || !current()) return;
    setBusy(true); setError(null);
    try {
      const result = await api.conceptApply(context.current.activeCourseId, draft.id, [...selected].map(id => ({ id, name: names[id] ?? "" })));
      if (!current()) return;
      await refreshPanelData();
      await loadConceptCardStatus();
      useAppStore.getState().bumpCourseDataRevision();
      onApplied?.();
      useAppStore.getState().flashStatusBanner(`已采用 ${result.concepts} 个概念，${result.rebound} 张题卡已归属；原课程已备份`);
      onClose();
    } catch (exc) { setError(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 p-6">
    <div ref={container} role="dialog" aria-modal="true" aria-label="AI 概念提炼" tabIndex={-1} className="flex max-h-[90vh] w-[min(900px,100%)] flex-col overflow-hidden rounded-2xl bg-bg-panel shadow-lv3">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-line p-4"><h2 className="font-medium">AI 概念提炼</h2><button type="button" disabled={busy} onClick={onClose} className="ml-auto text-sm">关闭</button></div>
      <div className="min-h-0 overflow-y-auto p-4">
        <p className="mb-4 text-sm leading-6 text-text-muted">从原文提炼可学习的知识点，合并同义概念，并为每项保留原文依据。预览后可以改名或取消采用；确认后会重新归属已有题卡并保留学习记录。</p>
        {error ? <p role="alert" className="mb-3 text-sm text-accent-fail">{error}</p> : null}
        {busy ? <p role="status" className="mb-3 text-sm">正在处理原文与题卡归属，长文可能需要几分钟…</p> : null}
        {draft ? <><p className="mb-3 text-xs text-text-muted">{draft.concepts.length} 个候选概念 · {draft.bindings.length} 张已有题卡可归属{draft.rejected ? ` · 已排除 ${draft.rejected} 项无有效依据的候选` : ""}</p>
          {draft.concepts.map(item => <div key={item.id} className="mb-3 rounded-xl border border-border-line p-3">
            <div className="flex items-center gap-2"><input type="checkbox" aria-label={`采用 ${item.name}`} checked={selected.has(item.id)} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} /><input aria-label={`概念名称 ${item.name}`} value={names[item.id] ?? ""} onChange={event => setNames({ ...names, [item.id]: event.target.value })} className="min-w-0 flex-1 rounded border border-border-line bg-bg-root px-2 py-1 text-sm" /><span className="text-xs text-text-faint">{item.area}</span></div>
            <div className="mt-2"><MarkdownView content={item.definition} compact modelOutput /></div><div className="mt-1 text-text-muted"><p className="text-xs">学习目标：</p><MarkdownView content={item.learning_objective} compact modelOutput /></div>
            {item.evidence.map((ref, index) => <div key={index} className="mt-2 rounded bg-bg-root p-2 text-xs leading-5"><button type="button" disabled={busy} className="text-accent-focus" onClick={async () => { if (!current()) return; onClose(); await readingOpenAt(ref.source, ref.page); }}>{ref.source} · 第 {ref.page} 页</button><blockquote className="text-text-muted">{ref.quote}</blockquote></div>)}
          </div>)}
        </> : null}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border-line p-4"><button type="button" disabled={busy} onClick={() => void generate()} className="rounded-lg border border-border-line px-3 py-2 text-sm">{draft ? "重新提炼" : "开始提炼"}</button>{draft ? <button type="button" disabled={busy || selected.size === 0 || [...selected].some(id => !names[id]?.trim())} onClick={() => void apply()} className="rounded-lg bg-accent-focus px-3 py-2 text-sm text-white">采用所选概念</button> : null}</div>
    </div>
  </div>;
}
