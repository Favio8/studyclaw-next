"use client";

/** DSH 风格设置面板：左侧分区导航，右侧配置内容，覆盖当前控制台。 */

import { useEffect, useRef, useState } from "react";
import { Bot, Database, Settings2, ShieldCheck, X } from "lucide-react";
import ModelsSection from "@/src/components/settings/ModelsSection";
import { MODES } from "@/src/lib/modes";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import type { SettingsPayload } from "@/src/types/api";

type Section = "general" | "models" | "agent";
/** 通用设置只管 ui 段（api_spec §2.6 v2.6 部分更新语义）；LLM 配置全部走模型配置 Tab。 */
type Draft = {
  defaultMode: SettingsPayload["ui"]["defaultMode"];
  agentPreset: string;
  permissionPreset: string;
  plugins: Record<string, boolean>;
};

function draftFrom(payload: SettingsPayload): Draft {
  const agent = payload.agent ?? { preset: "studyclaw-learning", presets: [] };
  const permissions = payload.permissions ?? { preset: "workspace-write", presets: [] };
  const plugins = payload.plugins ?? { inventory: [] };
  return {
    defaultMode: payload.ui.defaultMode,
    agentPreset: agent.preset,
    permissionPreset: permissions.preset,
    plugins: Object.fromEntries(plugins.inventory.map((item) => [item.id, item.enabled])),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const setMode = useAppStore((state) => state.setMode);
  const flashStatusBanner = useAppStore((state) => state.flashStatusBanner);
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loaded, setLoaded] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // W-10：焦点圈闭（打开聚焦首个控件、Tab 循环、Escape 尊重 busy、关闭还原）。
  useFocusTrap({
    containerRef: dialogRef,
    onEscape: () => { if (!busy) setOpen(false); },
  });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSection("general");
    setError(null);
    setLoaded(null);
    setDraft(null);
    void api.settings().then((payload) => {
      if (!alive) return;
      setLoaded(payload);
      setDraft(draftFrom(payload));
    }).catch((cause) => {
      if (alive) setError(errorMessage(cause));
    });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const runtime = loaded?.agent === undefined ? {} : { agentPreset: draft.agentPreset, permissionPreset: draft.permissionPreset, plugins: draft.plugins };
      const payload = await api.updateSettings({ defaultMode: draft.defaultMode, ...runtime });
      setLoaded(payload);
      setDraft(draftFrom(payload));
      setMode(payload.ui.defaultMode);
      flashStatusBanner("设置已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function closeOnMask(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !busy) setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={closeOnMask}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-[min(800px,calc(100vh-48px))] w-[min(800px,calc(100vw-48px))] overflow-hidden rounded-[24px] border border-border-line bg-bg-panel shadow-lv3"
      >
        <nav className="flex w-[188px] shrink-0 flex-col gap-[18px] px-3 pt-[22px]">
          <h2 id="settings-title" className="px-3 text-[16px] font-medium leading-6 text-text-primary">设置</h2>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              aria-current={section === "general" ? "true" : undefined}
              onClick={() => setSection("general")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "general" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Settings2 size={15} strokeWidth={1.8} aria-hidden />
              <span>通用设置</span>
            </button>
            <button
              type="button"
              aria-current={section === "agent" ? "true" : undefined}
              onClick={() => setSection("agent")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "agent" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Bot size={15} strokeWidth={1.8} aria-hidden />
              <span>Agent 运行时</span>
            </button>
            <button
              type="button"
              aria-current={section === "models" ? "true" : undefined}
              onClick={() => setSection("models")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "models" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Database size={15} strokeWidth={1.8} aria-hidden />
              <span>模型配置</span>
            </button>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[54px] shrink-0 items-start justify-between gap-2 px-[14px] pb-2 pl-2.5 pt-5">
            <span className="text-[14px] font-medium text-text-primary">{section === "general" ? "通用设置" : section === "models" ? "模型配置" : "Agent 运行时"}</span>
            <button
              type="button"
              aria-label="关闭设置"
              title="关闭设置"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {error ? (
            <div className="flex flex-col gap-3 rounded-xl border border-accent-fail/30 bg-accent-fail/5 p-4 text-[13px] text-accent-fail" role="alert">
              <span>{error}</span>
                <button type="button" className="self-start rounded-lg border border-accent-fail/40 px-3 py-1.5 hover:bg-accent-fail/10" onClick={() => { setError(null); void api.settings().then((payload) => { setLoaded(payload); setDraft(draftFrom(payload)); }).catch((cause) => setError(errorMessage(cause))); }}>重试</button>
              </div>
            ) : draft === null ? (
              <div className="text-[13px] text-text-faint">正在读取设置...</div>
            ) : section === "general" ? (
              <GeneralSettings draft={draft} update={update} />
            ) : section === "models" ? (
              <ModelsSection initial={loaded} />
            ) : (
              <RuntimeSettings payload={loaded} draft={draft} update={update} />
            )}
          </div>

          {section !== "models" ? (
            <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">
              <button type="button" disabled={busy} onClick={() => setOpen(false)} className="h-9 rounded-lg px-4 text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40">取消</button>
              <button type="button" disabled={busy || draft === null} onClick={() => void save()} className="h-9 rounded-lg bg-accent-focus px-4 text-[13px] font-medium text-white transition-colors hover:bg-accent-focus-hover disabled:opacity-40">{busy ? "保存中..." : "保存设置"}</button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">
              <span className="text-xs text-text-faint">模型配置在对应卡片内保存</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({
  draft,
  update,
}: {
  draft: Draft;
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  return (
    <section className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h3 className="text-[16px] font-medium text-text-primary">学习体验</h3>
        <p className="mt-1 text-[13px] leading-5 text-text-muted">这些选项保存在当前项目的 `.studyclaw/config.yaml` 中。</p>
      </div>
      <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
        默认学习模式
        <select value={draft.defaultMode} onChange={(event) => update("defaultMode", event.target.value as Draft["defaultMode"])} className="h-9 w-full max-w-[300px] rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus">
          {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        <span className="text-[12px] text-text-faint">新对话和导师对话默认使用此模式。</span>
      </label>
      <div className="border-t border-border-line pt-4">
        <h3 className="text-[14px] font-medium text-text-primary">当前应用</h3>
        <dl className="mt-3 grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
          <dt className="text-text-faint">配置文件</dt>
          <dd className="truncate text-text-muted">.studyclaw/config.yaml</dd>
          <dt className="text-text-faint">配置范围</dt>
          <dd className="text-text-muted">当前打开的学习项目</dd>
        </dl>
      </div>
    </section>
  );
}

function RuntimeSettings({
  payload,
  draft,
  update,
}: {
  payload: SettingsPayload | null;
  draft: Draft;
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  if (!payload) return null;
  const agent = payload.agent ?? { presets: [] };
  const permissions = payload.permissions ?? { presets: [] };
  const plugins = payload.plugins ?? { inventory: [] };
  const inputClass = "h-9 w-full max-w-[420px] rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus";
  return <section className="flex max-w-[640px] flex-col gap-6">
    <div>
      <h3 className="text-[16px] font-medium text-text-primary">Agent preset</h3>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">新建 Agent 时注入的上下文和工具集合。</p>
      <select value={draft.agentPreset} onChange={(event) => update("agentPreset", event.target.value)} className={`${inputClass} mt-3`} aria-label="Agent preset">
        {agent.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.description}</option>)}
      </select>
    </div>
    <div className="border-t border-border-line pt-5">
      <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-text-muted" aria-hidden /><h3 className="text-[14px] font-medium text-text-primary">权限 preset</h3></div>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">权限只控制默认审批策略；缺少隔离 Provider 的能力仍会 fail-closed。</p>
      <div className="mt-3 flex flex-col gap-2">
        {permissions.presets.map((preset) => <label key={preset.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${draft.permissionPreset === preset.id ? "border-accent-focus bg-accent-focus/5" : "border-border-line hover:bg-bg-card"}`}>
          <input type="radio" name="permission-preset" value={preset.id} checked={draft.permissionPreset === preset.id} onChange={() => update("permissionPreset", preset.id)} className="mt-0.5 accent-accent-focus" />
          <span className="min-w-0"><span className="block text-[13px] font-medium text-text-primary">{preset.name}</span><span className="mt-0.5 block text-[12px] text-text-faint">{preset.description}</span></span>
          <span className="ml-auto shrink-0 text-[11px] text-text-caption">{preset.approvalPolicy}</span>
        </label>)}
      </div>
    </div>
    <div className="border-t border-border-line pt-5">
      <h3 className="text-[14px] font-medium text-text-primary">Plugins</h3>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">内置插件状态来自 Host inventory；未配置的部署能力保持 degraded。</p>
      <div className="mt-3 flex flex-col gap-2">
        {plugins.inventory.map((plugin) => <label key={plugin.id} className="flex items-center gap-3 rounded-xl border border-border-line px-3 py-2.5">
          <input type="checkbox" checked={draft.plugins[plugin.id] ?? plugin.enabled} onChange={(event) => update("plugins", { ...draft.plugins, [plugin.id]: event.target.checked })} className="accent-accent-focus" />
          <span className="min-w-0"><span className="block text-[13px] text-text-primary">{plugin.name}</span><span className="block text-[11px] text-text-faint">{plugin.reason ?? `${plugin.source} · ${plugin.id}`}</span></span>
          <span className="ml-auto text-[11px] text-text-caption">{plugin.enabled ? "可用" : "degraded"}</span>
        </label>)}
      </div>
    </div>
  </section>;
}
