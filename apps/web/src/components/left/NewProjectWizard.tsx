"use client";

/**
 * DSH WorkspacePickFlow semantics: the native OS folder chooser is the primary
 * path (one dialog per open request; a native cancel is a normal close). The
 * server-side directory browser is the composition-level fallback (DSH
 * -browse backend) for hosts without an interactive desktop, reachable via
 * one link — never via raw path typing (the server registry is the single
 * source of truth).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Folder, FolderOpen, HardDrive, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "@/src/lib/api";
import { adoptWorkspace } from "@/src/lib/workspaceActions";
import { useAppStore } from "@/src/store/useAppStore";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500 && /^HTTP \d+$/.test(error.message)) {
      return `无法连接本地服务（${error.message}）：请确认 StudyClaw host 已启动后重试`;
    }
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "无法打开所选目录";
}

type Phase = "picking" | "adopting" | "error";
type Mode = "native" | "browse";

export default function NewProjectWizard() {
  const setWizardOpen = useAppStore((state) => state.setWizardOpen);
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("native");
  const armed = useRef(false);
  const alive = useRef(true);
  const pickInFlight = useRef(false);

  const adoptPath = useCallback(async (path: string) => {
    if (!path.trim()) return;
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
  }, [setWizardOpen]);

  const chooseAndOpen = useCallback(async () => {
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
        // FL-02：非 Windows 宿主没有原生选择器——"不可用"要自动落到目录浏览
        // 回退，而不是错误弹窗（更不能像用户取消那样直接关窗，否则首启死锁）。
        if (cause instanceof ApiError && cause.message.includes("原生目录选择器")) {
          setMode("browse");
          return;
        }
        setPhase("error");
        setError(errorMessage(cause));
      }
    }
  }, [adoptPath, setWizardOpen]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    // React Strict Mode may replay effects; one rising edge opens one chooser.
    if (armed.current) return;
    armed.current = true;
    void chooseAndOpen();
  }, [chooseAndOpen]);

  if (mode === "browse") {
    return <BrowsePicker onAdopt={(path) => void adoptPath(path)} onCancel={() => setWizardOpen(false)} onPreferNative={() => { setMode("native"); void chooseAndOpen(); }} busy={phase === "adopting"} />;
  }

  if (phase === "adopting") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="adopt-project-title" className="w-[min(92vw,380px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
          <div className="flex items-center gap-3"><LoaderCircle size={18} className="animate-spin text-accent-focus" aria-hidden /><h2 id="adopt-project-title" className="text-[15px] font-medium text-text-primary">正在打开项目</h2></div>
          <p className="mt-2 text-[13px] leading-5 text-text-muted">正在读取课程列表和项目设置…</p>
        </section>
      </div>
    );
  }

  if (phase === "picking") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="open-project-title" className="w-[min(92vw,430px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-focus/10 text-accent-focus"><FolderOpen size={18} aria-hidden /></span>
            <div className="min-w-0">
              <h2 id="open-project-title" className="text-[15px] font-medium text-text-primary">选择学习项目</h2>
              <p className="mt-1 text-[13px] leading-5 text-text-muted">正在打开系统文件夹选择器，请在弹出的窗口中选择项目文件夹。</p>
            </div>
            <button type="button" aria-label="取消" title="取消" onClick={() => setWizardOpen(false)} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-faint hover:bg-bg-card hover:text-text-primary"><X size={16} aria-hidden /></button>
          </div>
          <div className="mt-5 flex items-center gap-2 text-[12px] text-text-faint" role="status"><LoaderCircle size={14} className="animate-spin text-accent-focus" aria-hidden />等待系统选择器响应…</div>
          <div className="mt-4 border-t border-border-line pt-3">
            <button type="button" onClick={() => setMode("browse")} className="text-[12px] text-text-faint underline-offset-2 transition-colors hover:text-text-primary hover:underline">
              没有弹出窗口？改用目录浏览 →
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWizardOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="open-project-error-title" className="w-[min(92vw,430px)] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
        <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-fail/10 text-accent-fail"><FolderOpen size={18} aria-hidden /></span><div className="min-w-0"><h2 id="open-project-error-title" className="text-[15px] font-medium text-text-primary">无法打开项目</h2><p role="alert" className="mt-1 break-words text-[13px] leading-5 text-text-muted">{error ?? "未选择项目"}</p></div></div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button type="button" onClick={() => setMode("browse")} className="text-[12px] text-text-faint underline-offset-2 transition-colors hover:text-text-primary hover:underline">改用目录浏览 →</button>
          <div className="flex gap-2">
            <button type="button" onClick={() => setWizardOpen(false)} className="h-8 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card hover:text-text-primary">取消</button>
            <button type="button" onClick={() => void chooseAndOpen()} className="flex h-8 items-center gap-1.5 rounded-lg border border-border-line px-3 text-[13px] text-text-muted hover:bg-bg-card hover:text-text-primary"><RefreshCw size={14} aria-hidden />重新选择</button>
          </div>
        </div>
      </section>
    </div>
  );
}

interface BrowsePage {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

/** DSH browse-backend fallback: server-side directory listing, one page per RPC. */
function BrowsePicker({ onAdopt, onCancel, onPreferNative, busy }: {
  onAdopt: (path: string) => void;
  onCancel: () => void;
  onPreferNative: () => void;
  busy: boolean;
}) {
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  const navigate = useCallback(async (path: string | null) => {
    const seq = (requestSeq.current += 1);
    setLoadError(null);
    setLoading(true);
    try {
      const next = await api.browseDirectory(path);
      if (seq !== requestSeq.current) return;
      setPage(next);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setLoadError(errorMessage(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void navigate(null);
  }, [navigate]);

  const current = page?.path ?? "";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="browse-project-title" className="flex max-h-[80vh] w-[min(92vw,470px)] flex-col rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-focus/10 text-accent-focus"><FolderOpen size={18} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <h2 id="browse-project-title" className="text-[15px] font-medium text-text-primary">浏览选择项目文件夹</h2>
            <p className="mt-1 text-[13px] leading-5 text-text-muted">逐级进入目录，然后选择当前文件夹作为项目。</p>
          </div>
          <button type="button" aria-label="取消" title="取消" onClick={onCancel} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-faint hover:bg-bg-card hover:text-text-primary"><X size={16} aria-hidden /></button>
        </div>

        <div className="mt-4 flex items-center gap-2 border-b border-border-line pb-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void navigate(page === null ? null : page.parent ?? null)}
            title={current === "" ? "已在本机根目录" : "返回上一级"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border-line text-text-muted hover:bg-bg-card disabled:opacity-40"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <p className="min-w-0 flex-1 truncate font-mono text-[12px] leading-7 text-text-secondary" title={current === "" ? "此电脑" : current} aria-live="polite">
            {current === "" ? "此电脑" : current}
          </p>
          {loading ? <LoaderCircle size={14} className="shrink-0 animate-spin text-accent-focus" aria-hidden /> : null}
        </div>

        <div className="mt-1 min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="目录列表">
          {loadError !== null ? (
            <div className="flex flex-col items-start gap-3 px-2 py-6">
              <p role="alert" className="break-words text-[13px] leading-5 text-accent-fail">{loadError}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void navigate(page === null ? null : page.path)} className="h-8 rounded-lg border border-border-line px-3 text-[13px] text-text-muted hover:bg-bg-card">重试当前目录</button>
                <button type="button" onClick={() => void navigate(null)} className="h-8 rounded-lg border border-border-line px-3 text-[13px] text-text-muted hover:bg-bg-card">回到此电脑</button>
              </div>
            </div>
          ) : !loading && page !== null && page.entries.length === 0 ? (
            <p className="px-2 py-6 text-[13px] text-text-faint">此目录下没有子文件夹。</p>
          ) : page?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={false}
              disabled={loading || busy}
              onDoubleClick={() => onAdopt(current)}
              onClick={() => void navigate(entry.path)}
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
            >
              {/^[A-Za-z]:\\?$/.test(entry.name)
                ? <HardDrive size={15} className="shrink-0 text-text-faint" aria-hidden />
                : <Folder size={15} className="shrink-0 text-accent-focus/80" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border-line pt-4">
          <button type="button" disabled={busy} onClick={onPreferNative} className="text-[12px] text-text-faint underline-offset-2 transition-colors hover:text-text-primary hover:underline disabled:opacity-40">使用系统选择器</button>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={onCancel} className="h-8 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card hover:text-text-primary disabled:opacity-40">取消</button>
            <button
              type="button"
              disabled={loading || busy || current === ""}
              onClick={() => onAdopt(current)}
              title={current === "" ? "先选择一个文件夹" : `打开 ${current}`}
              className="h-8 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40"
            >
              {busy ? "正在打开项目…" : "选择此文件夹"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
