"use client";

/**
 * DSH WorkspacePickFlow semantics for the local project picker.
 *
 * The host owns the native directory chooser. This component owns the
 * single-flight state, cancellation/error surface, and a path fallback for
 * environments where the native chooser cannot be displayed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "@/src/lib/api";
import { adoptWorkspace } from "@/src/lib/workspaceActions";
import { useAppStore } from "@/src/store/useAppStore";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "无法打开所选目录";
}

type Phase = "picking" | "adopting" | "error";

export default function NewProjectWizard() {
  const setWizardOpen = useAppStore((state) => state.setWizardOpen);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [phase, setPhase] = useState<Phase>("picking");
  const armed = useRef(false);
  const alive = useRef(true);
  const pickInFlight = useRef(false);
  const busy = phase === "adopting";

  const adoptPath = useCallback(async (path: string) => {
    if (!path.trim() || busy) return;
    // A manual path supersedes the native chooser. Its eventual answer is
    // intentionally ignored so two selections cannot race adoption.
    pickInFlight.current = false;
    setError(null);
    setPhase("adopting");
    try {
      await adoptWorkspace(path.trim());
      if (alive.current) setWizardOpen(false);
    } catch (cause) {
      if (alive.current) {
        setPhase("error");
        setError(errorMessage(cause));
      }
    }
  }, [busy, setWizardOpen]);

  const chooseAndOpen = useCallback(async () => {
    if (busy) return;
    setError(null);
    setPhase("picking");
    pickInFlight.current = true;
    try {
      const { path } = await api.pickWorkspaceDirectory();
      if (!alive.current || !pickInFlight.current) return;
      pickInFlight.current = false;
      if (path === null) {
        // Native cancel is a normal close path in dsh, not an error.
        if (alive.current) setWizardOpen(false);
        return;
      }
      await adoptPath(path);
    } catch (cause) {
      if (!alive.current || !pickInFlight.current) return;
      pickInFlight.current = false;
      if (alive.current) {
        setPhase("error");
        setError(errorMessage(cause));
      }
    }
  }, [adoptPath, busy]);

  useEffect(() => {
    // React Strict Mode may replay effects; one rising edge opens one chooser.
    if (armed.current) return;
    armed.current = true;
    void chooseAndOpen();
  }, [chooseAndOpen]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onPathKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void adoptPath(manualPath);
  };

  if (phase === "picking") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="open-project-title" className="w-[min(92vw,430px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-focus/10 text-accent-focus"><FolderOpen size={18} aria-hidden /></span>
            <div className="min-w-0">
              <h2 id="open-project-title" className="text-[15px] font-medium text-text-primary">选择学习工作区</h2>
              <p className="mt-1 text-[13px] leading-5 text-text-muted">正在打开系统目录选择器，选择包含课程资料的文件夹。</p>
            </div>
            <button type="button" aria-label="取消" title="取消" onClick={() => setWizardOpen(false)} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-faint hover:bg-bg-card hover:text-text-primary"><X size={16} aria-hidden /></button>
          </div>
          <div className="mt-5 flex items-center gap-2 text-[12px] text-text-faint" role="status"><LoaderCircle size={14} className="animate-spin text-accent-focus" aria-hidden />等待系统选择器响应…</div>
          <div className="mt-5 border-t border-border-line pt-4">
            <label className="flex flex-col gap-1.5 text-[12px] text-text-secondary">也可以直接输入本地路径
              <input value={manualPath} onChange={(event) => setManualPath(event.target.value)} onKeyDown={onPathKeyDown} placeholder="例如 D:\\学习\\kubernetes" className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus" />
            </label>
            <div className="mt-3 flex justify-end"><button type="button" disabled={!manualPath.trim()} onClick={() => void adoptPath(manualPath)} className="h-8 rounded-lg bg-accent-focus px-3 text-[12px] font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40">打开路径</button></div>
          </div>
        </section>
      </div>
    );
  }

  if (phase === "adopting") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="adopt-project-title" className="w-[min(92vw,380px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
          <div className="flex items-center gap-3"><LoaderCircle size={18} className="animate-spin text-accent-focus" aria-hidden /><h2 id="adopt-project-title" className="text-[15px] font-medium text-text-primary">正在打开工作区</h2></div>
          <p className="mt-2 text-[13px] leading-5 text-text-muted">正在读取课程列表和项目设置…</p>
        </section>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWizardOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="open-project-error-title" className="w-[min(92vw,430px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
        <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-fail/10 text-accent-fail"><FolderOpen size={18} aria-hidden /></span><div className="min-w-0"><h2 id="open-project-error-title" className="text-[15px] font-medium text-text-primary">无法打开项目</h2><p role="alert" className="mt-1 break-words text-[13px] leading-5 text-text-muted">{error ?? "未选择工作区"}</p></div></div>
        <label className="mt-4 flex flex-col gap-1.5 text-[12px] text-text-secondary">输入路径重试
          <input value={manualPath} onChange={(event) => setManualPath(event.target.value)} onKeyDown={onPathKeyDown} placeholder="例如 D:\\学习\\kubernetes" className="h-9 rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus" />
        </label>
        <div className="mt-5 flex items-center justify-between gap-2"><button type="button" onClick={() => setWizardOpen(false)} className="h-8 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card hover:text-text-primary">取消</button><div className="flex gap-2"><button type="button" onClick={() => { setPhase("picking"); void chooseAndOpen(); }} className="flex h-8 items-center gap-1.5 rounded-lg border border-border-line px-3 text-[13px] text-text-muted hover:bg-bg-card hover:text-text-primary"><RefreshCw size={14} aria-hidden />重新选择</button><button type="button" disabled={!manualPath.trim()} onClick={() => void adoptPath(manualPath)} className="h-8 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40">打开路径</button></div></div>
      </section>
    </div>
  );
}
