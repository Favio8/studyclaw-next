"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, X } from "lucide-react";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import { useAppStore } from "@/src/store/useAppStore";
import AgentRuntimePanel from "./AgentRuntimePanel";

function DetailsDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reading = useAppStore(state => state.reader.action);
  const sessionId = useAppStore(state => state.activeSessionId);
  useFocusTrap({ containerRef: ref, onEscape: onClose });
  return createPortal(<div className="fixed inset-0 z-50 bg-black/20" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label="助手详情" className="absolute inset-y-0 right-0 flex w-[min(420px,100vw)] flex-col border-l border-border-line bg-bg-panel shadow-lv3">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-line px-4 py-3"><Activity size={16} aria-hidden /><span className="flex-1 text-sm font-medium">助手详情</span><button type="button" aria-label="关闭助手详情" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-bg-card"><X size={16} /></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {reading?.streaming ? <p role="status" className="mb-3 rounded-lg bg-bg-card p-3 text-xs text-accent-focus">阅读助手 · 正在{reading.kind === "translate" ? "翻译" : "解释"}资料</p> : null}
        {sessionId ? <AgentRuntimePanel /> : <p className="p-2 text-xs text-text-faint">开始或选择一段对话后，可查看运行记录。</p>}
      </div>
    </div>
  </div>, document.body);
}

export default function AssistantDetails() {
  const workspacePath = useAppStore(state => state.workspacePath);
  const generation = useAppStore(state => state.courseGeneration);
  const sessionId = useAppStore(state => state.activeSessionId);
  return <SessionDetails key={`${workspacePath}:${generation}:${sessionId}`} />;
}

function SessionDetails() {
  const [open, setOpen] = useState(false);
  const collapsed = useAppStore(state => state.rightPanelCollapsed);
  const reading = useAppStore(state => state.reader.action);
  const streaming = useAppStore(state => state.streaming);
  const pendingAsk = useAppStore(state => state.pendingAsk);
  const queued = useAppStore(state => state.queuedMessages.length);
  const error = useAppStore(state => state.messages.at(-1)?.error);
  if (collapsed && open) setOpen(false);
  const state = reading?.streaming || streaming ? "running" : pendingAsk || queued ? "waiting" : reading?.error || error ? "error" : "idle";
  const label = reading?.streaming ? `正在${reading.kind === "translate" ? "翻译" : "解释"}资料` : streaming ? "正在工作" : pendingAsk ? "等待回答" : queued ? "排队中" : state === "error" ? "最近操作失败" : "空闲";
  const color = state === "running" ? "bg-accent-focus animate-pulse" : state === "waiting" ? "bg-accent-warn" : state === "error" ? "bg-accent-fail" : "bg-text-caption";
  return <>
    <button type="button" aria-label="助手详情" aria-haspopup="dialog" aria-expanded={open} title={`助手详情 · ${label}`} data-assistant-state={state} onClick={() => setOpen(true)} className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus">
      <Activity size={15} strokeWidth={1.8} aria-hidden /><span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />
    </button>
    {open && !collapsed ? <DetailsDrawer onClose={() => setOpen(false)} /> : null}
  </>;
}
