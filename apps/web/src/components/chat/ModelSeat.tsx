"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCw, Settings2 } from "lucide-react";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { SessionModelDirectory, SessionModelEntry, SessionModelGroup, SettingsPayload } from "@/src/types/api";

type Pane = "root" | "models" | "effort";
const emptyDirectory: SessionModelDirectory = { current: null, routable: false, groups: [], failures: [] };

function directoryFromSettings(payload: SettingsPayload): SessionModelDirectory {
  const groups: SessionModelGroup[] = payload.providers.map((provider) => {
    const rows = provider.models.filter((model) => model.id !== "" && model.id !== "deepseek-chat" && model.id !== "deepseek-reasoner");
    const models: SessionModelEntry[] = rows.length > 0 ? rows : provider.model !== "" && provider.model !== "deepseek-chat" && provider.model !== "deepseek-reasoner"
      ? [{ id: provider.model, name: provider.model }]
      : [];
    return { id: provider.id, name: provider.name || provider.id, models };
  }).filter((group) => group.models.length > 0);
  const active = payload.providers.find((provider) => provider.id === payload.activeProviderId);
  const model = active?.model && active.model !== "deepseek-chat" && active.model !== "deepseek-reasoner" ? active.model : null;
  return { current: model ? { provider: payload.activeProviderId, model } : null, routable: Boolean(model && active?.apiKeyConfigured), groups, failures: [] };
}

function modelFor(directory: SessionModelDirectory, provider: string, model: string): SessionModelEntry | null {
  return directory.groups.find((group) => group.id === provider)?.models.find((item) => item.id === model) ?? null;
}

export default function ModelSeat() {
  const activeModel = useAppStore((s) => s.activeModel);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [directory, setDirectory] = useState<SessionModelDirectory>(emptyDirectory);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = activeCourseId && activeSessionId ? await api.sessionModels(activeCourseId, activeSessionId) : directoryFromSettings(await api.settings());
      setDirectory(next);
      setActiveModel(next.current ? { providerId: next.current.provider, model: next.current.model, ...(next.current.effort === undefined ? {} : { effort: next.current.effort }) } : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型目录加载失败");
    } finally {
      setLoading(false);
    }
  }, [activeCourseId, activeSessionId, setActiveModel]);

  useEffect(() => { if (open) void loadDirectory(); }, [open, loadDirectory]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pane !== "root") setPane("root"); else setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("mousedown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open, pane]);

  async function choose(provider: string, model: string, effort?: string | null) {
    if (selecting) return;
    const previous = activeModel;
    setSelecting(`${provider}/${model}/${effort ?? "default"}`);
    try {
      const selection = { provider, model, ...(effort === undefined ? {} : { effort }) };
      if (activeCourseId && activeSessionId) {
        const result = await api.selectSessionModel(activeCourseId, activeSessionId, selection);
        setActiveModel({ providerId: result.selected.provider, model: result.selected.model, ...(result.selected.effort === undefined ? {} : { effort: result.selected.effort }) });
        setDirectory((current) => ({ ...current, current: result.selected }));
      } else {
        setActiveModel({ providerId: provider, model, ...(effort === undefined ? {} : { effort }) });
        setDirectory((current) => ({ ...current, current: { provider, model, ...(effort === undefined ? {} : { effort }) }, routable: true }));
      }
      setOpen(false);
      setPane("root");
    } catch (cause) {
      if (previous) setActiveModel(previous);
      flashStatusBanner(cause instanceof Error ? `模型切换失败：${cause.message}` : "模型切换失败");
    } finally { setSelecting(null); }
  }

  const current = activeModel ?? directory.current;
  const currentProvider = activeModel?.providerId ?? directory.current?.provider ?? "";
  const currentModel = current ? modelFor(directory, currentProvider, current.model) : null;
  const caption = currentModel?.name ?? current?.model ?? "选择模型";
  const currentKey = current ? `${currentProvider}/${current.model}` : "";
  const effortName = current?.effort ? currentModel?.efforts?.find((effort) => effort.id === current.effort)?.name ?? current.effort : "跟随模型默认";
  // 派生量收窄（map 回调内 TS 不保留 current 非空推断）。
  const efforts = currentModel?.efforts ?? [];
  const currentEffort = current?.effort ?? null;
  const currentModelId = current?.model ?? "";

  return <div ref={rootRef} className="relative">
    <button type="button" aria-expanded={open} aria-haspopup="menu" title="选择模型" onClick={() => { setOpen((value) => !value); setPane("root"); }} className="flex h-7 max-w-[240px] items-center gap-1 rounded-lg bg-bg-card px-2 text-[13px] font-medium leading-5 text-text-primary">
      <span className="max-w-[150px] truncate">{caption}</span><span className="text-[10px] text-text-faint">{currentProvider ? `· ${currentProvider}` : ""}</span><ChevronDown size={12} aria-hidden />
    </button>
    {open ? <div role="menu" aria-label="选择模型" className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-80 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3">
      {pane === "root" ? <>
        <button type="button" role="menuitem" aria-label="模型" className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card" onClick={() => setPane("models")}><span className="flex-1">模型</span><span aria-hidden className="max-w-[150px] truncate text-[11px] text-text-faint">{caption}</span><ChevronRight size={14} className="text-text-faint" aria-hidden /></button>
        <button type="button" role="menuitem" aria-label="思考强度" className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card" onClick={() => setPane("effort")}><span className="flex-1">思考强度</span><span aria-hidden className="max-w-[150px] truncate text-[11px] text-text-faint">{effortName}</span><ChevronRight size={14} className="text-text-faint" aria-hidden /></button>
      </> : <>
        <button type="button" role="menuitem" className="mb-1 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-text-muted hover:bg-bg-card" onClick={() => setPane("root")}><ChevronLeft size={14} aria-hidden /><span>{pane === "models" ? "模型" : "思考强度"}</span></button>
        {pane === "models" ? <>
          {loading ? <div className="px-2 py-2 text-xs text-text-faint">正在加载模型目录...</div> : null}
          {error ? <div className="flex items-center gap-2 px-2 py-2 text-xs text-accent-fail"><span className="min-w-0 flex-1">{error}</span><button type="button" aria-label="重试加载模型目录" className="shrink-0" onClick={() => void loadDirectory()}><RotateCw size={13} aria-hidden /></button></div> : null}
          {directory.failures.map((failure) => <div key={failure.id} className="px-2 py-1.5 text-[11px] text-accent-warn">{failure.name}：{failure.message}</div>)}
          {directory.groups.map((group) => <section key={group.id} role="group" aria-label={group.name} className="border-t border-border-faint py-1 first:border-t-0"><div className="px-2 py-1 text-[11px] font-medium text-text-faint">{group.name}</div>{group.models.map((model) => { const key = `${group.id}/${model.id}`; const selected = currentKey === key; return <button key={model.id} type="button" role="menuitemradio" aria-checked={selected} disabled={selecting !== null} onClick={() => void choose(group.id, model.id)} className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-50 ${selected ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}><span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>{selected ? <Check size={14} className="text-accent-focus" aria-hidden /> : null}</button>; })}</section>)}
          {!loading && directory.groups.length === 0 ? <div className="px-2 py-2 text-xs text-text-faint">还没有可用模型。</div> : null}
          {!directory.routable ? <button type="button" className="mt-1 flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs text-accent-focus hover:bg-bg-card" onClick={() => { setOpen(false); setSettingsOpen(true); }}><Settings2 size={13} aria-hidden />打开模型配置</button> : null}
        </> : <>
          {!current ? <div className="px-2 py-2 text-xs text-text-faint">请先选择一个模型。</div> : null}
          {current && (currentModel?.efforts?.length ?? 0) === 0 ? <div className="px-2 py-2 text-xs text-text-faint">当前模型不提供思考强度选项。</div> : null}
          {efforts.length > 0 ? <>
            {efforts.map((effort) => <button key={effort.id} type="button" role="menuitemradio" aria-checked={currentEffort === effort.id} disabled={selecting !== null} onClick={() => void choose(currentProvider, currentModelId, effort.id)} className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-50 ${currentEffort === effort.id ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}><span className="min-w-0 flex-1"><span className="block">{effort.name}</span>{effort.description ? <span className="block truncate text-[11px] text-text-faint">{effort.description}</span> : null}</span>{currentEffort === effort.id ? <Check size={14} className="text-accent-focus" aria-hidden /> : null}</button>)}
            <button type="button" role="menuitemradio" aria-checked={currentEffort === null} disabled={selecting !== null} onClick={() => void choose(currentProvider, currentModelId, null)} className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-50 ${currentEffort === null ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}><span className="flex-1">跟随模型默认</span>{currentEffort === null ? <Check size={14} className="text-accent-focus" aria-hidden /> : null}</button>
          </> : null}
        </>}
      </>}
    </div> : null}
  </div>;
}
