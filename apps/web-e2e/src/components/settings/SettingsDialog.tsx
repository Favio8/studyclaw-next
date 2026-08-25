"use client";

/** DSH 风格设置面板：左侧分区导航，右侧配置内容，覆盖当前控制台。 */

import { useEffect, useRef, useState } from "react";
import { Database, Settings2, X } from "lucide-react";
import ModelsSection from "@/src/components/settings/ModelsSection";
import { MODES } from "@/src/lib/modes";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { SettingsPayload } from "@/src/types/api";

type Section = "general" | "models";
/** 通用设置只管 ui 段（api_spec §2.6 v2.6 部分更新语义）；LLM 配置全部走模型配置 Tab。 */
type Draft = {
  defaultMode: SettingsPayload["ui"]["defaultMode"];
};

function draftFrom(payload: SettingsPayload): Draft {
  return {
    defaultMode: payload.ui.defaultMode,
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSection("general");
    setError(null);
    setLoaded(null);
    setDraft(null);
    queueMicrotask(() => closeButtonRef.current?.focus());
    void api.settings().then((payload) => {
      if (!alive) return;
      setLoaded(payload);
      setDraft(draftFrom(payload));
    }).catch((cause) => {
      if (alive) setError(errorMessage(cause));
    });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, open, setOpen]);

  if (!open) return null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await api.updateSettings({ defaultMode: draft.defaultMode });
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
            <span className="text-[14px] font-medium text-text-primary">{section === "general" ? "通用设置" : "模型配置"}</span>
            <button
              ref={closeButtonRef}
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
            ) : (
              <ModelsSection initial={loaded} />
            )}
          </div>

          {section === "general" ? (
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
        <span className="text-[12px] text-text-faint">新会话和导师对话默认使用此模式。</span>
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
