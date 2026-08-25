"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Clock3, X } from "lucide-react";
import { api } from "@/src/lib/api";
import type { ApprovalRequestView } from "@/src/types/api";
import { iconFor } from "@/src/components/chat/ToolFold";

interface ApprovalPanelProps {
  agentId: string | null;
}

export default function ApprovalPanel({ agentId }: ApprovalPanelProps) {
  const [items, setItems] = useState<ApprovalRequestView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) { setItems([]); return; }
    try { setItems((await api.approvals(agentId)).items); setError(null); } catch { setError("审批状态暂时无法加载"); }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    if (!agentId) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [agentId, refresh]);

  async function resolve(item: ApprovalRequestView, decision: "allow" | "deny" | "cancel") {
    setBusy(item.id);
    try { await api.resolveApproval(item.id, decision); setItems((current) => current.filter((candidate) => candidate.id !== item.id)); setError(null); }
    catch { setError("审批处理失败，请重试"); }
    finally { setBusy(null); }
  }

  if (items.length === 0 && error === null) return null;
  return <div className="mx-auto mb-2 flex w-full max-w-[748px] flex-col gap-1 px-8" aria-label="待处理审批">
    {error ? <div className="flex items-center gap-2 rounded-lg border border-accent-fail/30 bg-accent-fail/5 px-2.5 py-1.5 text-xs text-accent-fail" role="alert">{error}<button type="button" className="ml-auto underline" onClick={() => void refresh()}>重试</button></div> : null}
    {items.map((item) => { const ToolIcon = iconFor(item.name); return <div key={item.id} className="flex min-h-9 items-center gap-2 rounded-lg border border-accent-warn/30 bg-accent-warn/5 px-2.5 py-1.5 text-xs" data-approval-id={item.id}>
      <ToolIcon size={14} className="shrink-0 text-accent-warn" aria-hidden />
      <div className="min-w-0 flex-1"><div className="truncate font-medium text-text-primary">需要确认：{item.name}</div><div className="truncate text-text-faint">{JSON.stringify(item.args)}</div><div className="mt-0.5 flex items-center gap-1 text-[10px] text-text-caption"><Clock3 size={10} aria-hidden />{formatExpiry(item.expiresAt)}</div></div>
      <button type="button" aria-label="允许工具执行" title="允许" disabled={busy !== null} onClick={() => void resolve(item, "allow")} className="flex h-6 w-6 items-center justify-center rounded-md text-accent-pass hover:bg-accent-pass/10 disabled:opacity-50"><Check size={14} aria-hidden /></button>
      <button type="button" aria-label="拒绝工具执行" title="拒绝" disabled={busy !== null} onClick={() => void resolve(item, "deny")} className="flex h-6 w-6 items-center justify-center rounded-md text-accent-fail hover:bg-accent-fail/10 disabled:opacity-50"><X size={14} aria-hidden /></button>
      <button type="button" aria-label="取消工具执行" title="取消" disabled={busy !== null} onClick={() => void resolve(item, "cancel")} className="flex h-6 w-6 items-center justify-center rounded-md text-text-faint hover:bg-bg-card disabled:opacity-50"><Ban size={13} aria-hidden /></button>
    </div>; })}
  </div>;
}

function formatExpiry(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "等待处理"
  const remaining = Math.max(0, Math.ceil((time - Date.now()) / 1000));
  return remaining === 0 ? "即将过期" : `${remaining < 60 ? remaining + " 秒" : Math.ceil(remaining / 60) + " 分钟"}后过期`;
}
