"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, Wrench } from "lucide-react";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { AgentProjectionView, AgentStatusView } from "@/src/types/api";
import PlanPanel from "@/src/components/panel/PlanPanel";
import TodoPanel from "@/src/components/panel/TodoPanel";

const EMPTY: AgentProjectionView = {
  sessionId: "", phase: "idle", currentModel: null, modelProvenance: { provider: "", model: "", effort: null, requestId: null }, agentConfig: null, agentRuntime: null, messages: [], tools: [], pendingAsk: null,
  pendingApprovals: [], plan: { steps: [], updatedAt: null }, todos: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, provider: null, model: null }, cancellation: null,
  maintenance: { running: false, kind: null, lastAt: null }, maintenanceJobs: [], compaction: { count: 0, lastSeq: null, summary: null },
  lineage: { parentSessionId: null, forkSeq: null }, children: [], lastSeq: 0,
};

const phaseLabel: Record<AgentStatusView["phase"], string> = {
  idle: "空闲", queued: "排队中", running: "运行中", waiting: "等待输入", cancelled: "已取消", disposed: "已销毁",
};

export default function AgentRuntimePanel() {
  const sessionId = useAppStore((state) => state.activeSessionId);
  const [projection, setProjection] = useState<AgentProjectionView>(EMPTY);
  const [status, setStatus] = useState<AgentStatusView | null>(null);
  const [agents, setAgents] = useState<AgentStatusView[]>([]);
  const [details, setDetails] = useState(false);
  // 运行能力默认收成一行摘要：5 项里 4 项"降级"时逐条平铺只是噪音，
  // 需要排查再展开（摘要里保留项数与降级数这两个关键数字）。
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) { setProjection(EMPTY); setStatus(null); setAgents([]); return; }
    const agentId = `study-${sessionId}`;
    try {
      const [nextProjection, nextStatus, nextAgents] = await Promise.all([api.agentProjection(agentId), api.agentStatus(agentId), api.agents()]);
      setProjection(nextProjection); setStatus(nextStatus); setAgents(nextAgents.agents);
    } catch { /* a session can exist before its Agent is resumed */ }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, sessionId]);

  if (!sessionId) return null;
  const statusPhase = status?.phase ?? projection.phase;
  const latestTools = projection.tools.slice(-4).reverse();
  const contextPercent = Math.min(100, Math.round((projection.usage.inputTokens / 128000) * 100));
  const childRows = projection.children.map((child) => ({
    ...child,
    status: agents.find((agent) => agent.agentId === child.agentId) ?? null,
  }));
  const capabilities = projection.agentRuntime?.capabilities ?? status?.capabilities ?? [];
  const degradedCount = capabilities.filter((capability) => !capability.available).length;
  return <section className="shrink-0 rounded-lg border border-border-line bg-bg-panel/70 p-2.5" data-agent-runtime-panel="">
    <div className="mb-2 flex items-center gap-2 text-[12px] text-text-muted">
      <Activity size={14} className={statusPhase === "running" ? "text-accent-focus" : "text-text-faint"} aria-hidden />
      <span className="font-medium text-text-primary">Agent</span>
      <span className="ml-auto rounded-md bg-bg-card px-1.5 py-0.5 text-[11px]">{phaseLabel[statusPhase]}</span>
      {status?.queued ? <span className="text-text-faint">队列 {status.queued}</span> : null}
    </div>
    <div className="grid grid-cols-2 gap-1.5 text-[11px] text-text-faint">
      <div className="truncate" title={projection.currentModel ? `${projection.currentModel.provider}/${projection.currentModel.model}` : "未选择模型"}>模型：{projection.currentModel?.model ?? "未选择"}</div>
      <div className="text-right">事件：{projection.lastSeq}</div>
      <div>Token：{projection.usage.totalTokens}</div>
      <div className="text-right">工具：{projection.tools.length}</div>
      {projection.modelProvenance.effort ? <div className="truncate">思考：{projection.modelProvenance.effort}</div> : null}
      {projection.agentConfig ? <div className="truncate" title={`${projection.agentConfig.agentPreset} · ${projection.agentConfig.permissionPreset}`}>权限：{projection.agentConfig.permissionPreset === "read-only" ? "只读" : projection.agentConfig.permissionPreset === "danger-full-access" ? "完全访问" : "项目写入"}</div> : null}
      {projection.compaction.count > 0 ? <div className="text-right">压缩：{projection.compaction.count}</div> : null}
    </div>
    {capabilities.length > 0 ? <div className="mt-2 border-t border-border-faint pt-2" data-agent-capabilities=""><button type="button" aria-expanded={capabilitiesOpen} onClick={() => setCapabilitiesOpen((value) => !value)} className="flex w-full items-center gap-1 text-left text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary"><ChevronDown size={12} className={capabilitiesOpen ? "rotate-180" : ""} aria-hidden /><span>运行能力</span><span className="ml-auto font-normal text-text-faint">{capabilities.length} 项{degradedCount > 0 ? ` · ${degradedCount} 降级` : ""}</span></button>{capabilitiesOpen ? <div className="mt-1 space-y-1">{capabilities.map((capability) => <div key={capability.id} className="flex min-w-0 items-center gap-1.5 text-[11px]" title={capability.available ? capability.id : `${capability.reason ?? "不可用"}${capability.installAction ? ` · ${capability.installAction}` : ""}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${capability.available ? "bg-accent-pass" : "bg-accent-warn"}`} aria-hidden /><span className="truncate text-text-faint">{capability.id}</span><span className={`ml-auto shrink-0 ${capability.available ? "text-accent-pass" : "text-accent-warn"}`}>{capability.available ? "可用" : "降级"}</span></div>)}</div> : null}</div> : null}
    <div className="mt-2 border-t border-border-faint pt-2" data-context-meter="">
      <div className="mb-1 flex items-center justify-between text-[11px] text-text-faint"><span>上下文</span><span title={`${projection.usage.inputTokens} / 128000 tokens`}>{contextPercent}%</span></div>
      <div role="progressbar" aria-label="上下文用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercent} className="h-1 overflow-hidden rounded-full bg-bg-card"><div className="h-full rounded-full bg-accent-focus transition-[width]" style={{ width: `${contextPercent}%` }} /></div>
    </div>
    <PlanPanel steps={projection.plan.steps} />
    <TodoPanel items={projection.todos} />
    {projection.maintenanceJobs.length > 0 ? <div className="mt-2 border-t border-border-faint pt-2" data-maintenance-jobs=""><div className="mb-1 text-[11px] font-medium text-text-muted">维护任务</div>{projection.maintenanceJobs.slice(-3).reverse().map((job) => <div key={job.jobId} className="flex items-center gap-1.5 truncate text-[11px] text-text-faint"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${job.status === "done" ? "bg-accent-pass" : job.status === "failed" ? "bg-accent-fail" : job.status === "running" ? "bg-accent-focus" : "bg-accent-warn"}`} aria-hidden /><span className="truncate">{job.kind === "compaction" ? "压缩" : "检查点"} · {job.status === "queued" ? "排队中" : job.status === "running" ? "运行中" : job.status === "done" ? "已完成" : "失败"}</span></div>)}</div> : null}
    {childRows.length > 0 ? <div className="mt-2 border-t border-border-faint pt-2" data-subagent-status=""><div className="mb-1 text-[11px] font-medium text-text-muted">子 Agent</div>{childRows.map((child) => <div key={child.agentId} className="flex items-center gap-1.5 truncate text-[11px] text-text-faint"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${child.status?.phase === "running" ? "bg-accent-focus" : child.status?.phase === "waiting" ? "bg-accent-warn" : "bg-accent-pass"}`} aria-hidden /><span className="truncate">{child.agentId}</span><span className="ml-auto shrink-0">{child.status ? phaseLabel[child.status.phase] : "已创建"}</span></div>)}</div> : null}
    {latestTools.length > 0 ? <div className="mt-2 border-t border-border-faint pt-2"><div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><Wrench size={12} aria-hidden />最近工具</div>{latestTools.map((tool) => <div key={`${tool.callId}-${tool.seq}`} className="flex items-center gap-1.5 truncate text-[11px] text-text-faint"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tool.status === "success" ? "bg-accent-pass" : tool.status === "running" ? "bg-accent-focus" : "bg-accent-warn"}`} aria-hidden /><span className="truncate">{tool.name} · {tool.summary}</span></div>)}</div> : null}
    <button type="button" aria-expanded={details} onClick={() => setDetails((value) => !value)} className="mt-2 flex h-6 w-full items-center gap-1 border-t border-border-faint pt-2 text-left text-[11px] text-text-faint hover:text-text-primary" data-trajectory-toggle=""><ChevronDown size={12} className={details ? "rotate-180" : ""} aria-hidden /><span>轨迹详情</span><span className="ml-auto">{projection.lastSeq} events</span></button>
    {details ? <div className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded-md bg-bg-card/60 p-1.5 text-[11px] text-text-faint" data-trajectory-details="">
      {projection.messages.slice(-6).map((message) => <div key={message.seq} className="flex gap-1.5"><span className="w-5 shrink-0 font-mono text-text-caption">#{message.seq}</span><span className="shrink-0 text-text-muted">{message.role === "user" ? "用户" : "Agent"}</span><span className="min-w-0 truncate">{message.content}</span></div>)}
      {projection.messages.length === 0 ? <div className="text-text-caption">暂无轨迹</div> : null}
    </div> : null}
  </section>;
}
