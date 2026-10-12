"use client";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/src/lib/api";
import { refreshPanelData } from "@/src/lib/panelData";
import { readingOpenAt } from "@/src/lib/readingFlow";
import { useAppStore } from "@/src/store/useAppStore";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import type { SemanticDraft } from "@/src/types/api";
import MarkdownView from "@/src/components/chat/MarkdownView";

export default function ConceptEditor({ source, onApplied }: { source?: string; onApplied?: () => void }) {
  const courseId = useAppStore(s => s.activeCourseId);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus">AI 概念提炼</button>
    <button type="button" disabled={filling || !courseId} className="ml-2 rounded-md border border-border-line px-2 py-1 text-xs text-text-muted" onClick={async () => {
      if (!courseId) return;
      const context = useAppStore.getState(); setFilling(true); setFillError(null);
      try { const result = await api.conceptCards(courseId); if (useAppStore.getState().courseGeneration === context.courseGeneration) { await refreshPanelData(); context.flashStatusBanner(result.generated ? `已为 ${result.conceptsFilled} 个缺题概念补齐 ${result.generated} 张题卡` : "每个概念都已有题卡"); } }
      catch (error) { setFillError(error instanceof Error ? error.message : String(error)); }
      finally { setFilling(false); }
    }}>{filling ? "补齐中…" : "补齐概念题卡"}</button>
    {fillError ? <span role="alert" className="text-xs text-accent-fail">{fillError}</span> : null}
    {open ? createPortal(<ConceptDialog source={source} onClose={() => setOpen(false)} onApplied={onApplied} />, document.body) : null}
  </>;
}

function ConceptDialog({ source, onClose, onApplied }: { source?: string; onClose: () => void; onApplied?: () => void }) {
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
      const files = source ? [source] : (await api.courseFiles(courseId)).files.map(file => String(file.relative));
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
      await refreshPanelData(); onApplied?.();
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
