"use client";

/**
 * 输入栏模型座位（api_spec §3.1 v2.6）：显示当前 provider · model，
 * 点击向上弹出供应商菜单，选中即全局切换（POST activate）。
 * 当前值来自 chat meta 帧写入的 store.activeModel；供应商列表首次打开时
 * 拉取 /api/settings 并缓存，切换成功后用响应刷新。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { ProviderPayload, SettingsPayload } from "@/src/types/api";

export default function ModelSeat() {
  const activeModel = useAppStore((s) => s.activeModel);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderPayload[] | null>(null);
  const [activeId, setActiveId] = useState("");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const loadProviders = useCallback(() => {
    void api.settings().then((payload: SettingsPayload) => {
      setProviders(payload.providers);
      setActiveId(payload.activeProviderId);
      // 座位尚无真值（本轮还没发过消息）：用服务端激活态播种
      if (!useAppStore.getState().activeModel) {
        const active = payload.providers.find((p) => p.id === payload.activeProviderId);
        if (active) setActiveModel({ providerId: active.id, model: active.model });
      }
    }).catch(() => setProviders([]));
  }, [setActiveModel]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && providers === null) loadProviders();
  }

  async function choose(provider: ProviderPayload) {
    if (switchingId !== null) return;
    if (provider.id === activeId) {
      setOpen(false);
      return;
    }
    setSwitchingId(provider.id);
    try {
      const payload = await api.activateProvider(provider.id);
      setProviders(payload.providers);
      setActiveId(payload.activeProviderId);
      setActiveModel({ providerId: provider.id, model: provider.model });
      flashStatusBanner(`已切换为 ${provider.name || provider.id}`);
      setOpen(false);
    } catch (cause) {
      flashStatusBanner(cause instanceof Error ? `切换失败：${cause.message}` : "切换失败");
    } finally {
      setSwitchingId(null);
    }
  }

  const caption = activeModel
    ? `${activeModel.providerId || "provider"} · ${activeModel.model}`
    : "选择模型";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="切换模型"
        onClick={toggle}
        className="flex h-7 max-w-[190px] items-center gap-1 rounded-lg bg-bg-card px-2 text-[13px] font-medium leading-5 text-text-primary"
      >
        <span className="truncate">{caption}</span>
        <span className="text-[10px] text-text-faint">⌄</span>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="切换模型"
          className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-64 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3"
        >
          {(providers ?? []).length === 0 ? (
            <div className="p-2">
              <p className="text-xs text-text-faint">还没有可用的供应商。</p>
              <button
                type="button"
                onClick={() => { setOpen(false); setSettingsOpen(true); }}
                className="mt-1 text-xs text-accent-focus hover:underline"
              >
                打开模型配置
              </button>
            </div>
          ) : (
            (providers ?? []).map((provider) => {
              const active = provider.id === activeId;
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={switchingId !== null}
                  onClick={() => void choose(provider)}
                  className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-50 ${active ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{provider.name || provider.id}</span>
                  <span className="shrink-0 text-[11px] text-text-faint">{provider.model}</span>
                  {active ? <span aria-hidden className="text-accent-focus">✓</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
