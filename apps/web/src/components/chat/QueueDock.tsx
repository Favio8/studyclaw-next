"use client";

import { useCallback, useEffect, useState } from "react";
import { List, Square } from "lucide-react";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { AgentStatusView } from "@/src/types/api";

/** Compact DSH-style queue surface for turns waiting behind the live Agent. */
export default function QueueDock() {
  const sessionId = useAppStore((state) => state.activeSessionId);
  const flashStatusBanner = useAppStore((state) => state.flashStatusBanner);
  const [status, setStatus] = useState<AgentStatusView | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) { setStatus(null); return; }
    try { setStatus(await api.agentStatus(`study-${sessionId}`)); }
    catch { setStatus(null); }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const timer = window.setInterval(() => void refresh(), 900);
    return () => window.clearInterval(timer);
  }, [refresh, sessionId]);

  if (!status || status.queued <= 0) return null;

  async function cancelQueued() {
    try {
      await api.cancelAgent(status!.agentId, false);
      await refresh();
    } catch (cause) {
      flashStatusBanner(`队列取消失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return <div className="mx-auto mb-1 flex w-full max-w-[748px] items-center gap-2 px-8" data-queue-dock="">
    <div className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border-line bg-bg-card/70 px-2 text-[11px] text-text-muted">
      <List size={13} strokeWidth={1.8} className="shrink-0 text-accent-focus" aria-hidden />
      <span className="truncate">队列中 {status.queued} 个回合</span>
      {status.phase === "running" ? <span className="ml-auto shrink-0 text-text-faint">Agent 运行中</span> : null}
    </div>
    <button type="button" aria-label="取消排队回合" title="取消排队回合" onClick={() => void cancelQueued()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-line text-text-muted hover:bg-bg-card hover:text-accent-fail">
      <Square size={11} fill="currentColor" strokeWidth={1.8} aria-hidden />
    </button>
  </div>;
}
