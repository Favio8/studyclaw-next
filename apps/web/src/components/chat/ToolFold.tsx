"use client";

/**
 * DSH-style tool disclosure: one compact summary row per tool call with a
 * tool-owned icon, a terminal state dot, and an optional expanded detail body.
 * The tool result remains outside markdown so model output is never polluted.
 */

import { useState, type ComponentType } from "react";
import {
  BookOpen,
  Brain,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  FilePenLine,
  FileSearch,
  FileText,
  Layers3,
  ListChecks,
  NotebookPen,
  OctagonAlert,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Globe,
  ListTodo,
  Terminal,
  UsersRound,
  TriangleAlert,
} from "lucide-react";
import type { ToolCallView } from "@/src/types/api";

interface ToolFoldProps {
  tools: ToolCallView[];
}

type ToolIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export const TOOL_ICONS: Record<string, ToolIcon> = {
  read_source: FileSearch,
  search_sources: Search,
  get_course_state: BookOpen,
  get_task_pool: Layers3,
  get_memory: Brain,
  create_card: NotebookPen,
  generate_dynamic_card: Sparkles,
  run_review: RotateCcw,
  run_quiz: ListChecks,
  evaluate_answer: ClipboardCheck,
  sync_sources: RefreshCw,
  write_note: FilePenLine,
  ask_user_question: CircleHelp,
  read_file: FileText,
  search_files: Search,
  write_file: FilePenLine,
  run_command: Terminal,
  fetch_url: Globe,
  search_web: Globe,
  plan: ListTodo,
  todo: ListChecks,
  spawn_agent: UsersRound,
  __tool_loop_limit__: TriangleAlert,
};

const TOOL_TITLES: Record<string, string> = {
  read_source: "读取资料",
  search_sources: "搜索资料",
  get_course_state: "课程状态",
  get_task_pool: "题卡池",
  get_memory: "学习记忆",
  create_card: "生成复习卡",
  generate_dynamic_card: "生成动态卡",
  run_review: "开始复习",
  run_quiz: "开始测验",
  evaluate_answer: "评估作答",
  sync_sources: "同步资料",
  write_note: "记录笔记",
  ask_user_question: "导师提问",
  read_file: "读取文件",
  search_files: "搜索文件",
  write_file: "写入文件",
  run_command: "执行命令",
  fetch_url: "获取网页",
  search_web: "搜索网页",
  plan: "更新计划",
  todo: "更新待办",
  spawn_agent: "调度子 Agent",
  __tool_loop_limit__: "工具循环",
};

const STATUS_LABEL: Record<ToolCallView["status"], string> = {
  running: "运行中",
  success: "成功",
  degraded: "降级",
  rejected: "拒绝",
};

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function iconFor(name: string): ToolIcon {
  return TOOL_ICONS[name] ?? OctagonAlert;
}

function titleFor(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

function LeadingIcon({ tool }: { tool: ToolCallView }) {
  if (tool.status === "rejected") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-fail" data-tool-state-dot="rejected" />;
  }
  if (tool.status === "degraded") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-warn" data-tool-state-dot="degraded" />;
  }
  const Icon = iconFor(tool.name);
  return (
    <Icon
      size={14}
      strokeWidth={1.8}
      aria-hidden
      className={tool.status === "running" ? "text-accent-focus" : "text-text-muted"}
    />
  );
}

function statusClass(status: ToolCallView["status"]): string {
  switch (status) {
    case "success": return "text-accent-pass";
    case "degraded": return "text-accent-warn";
    case "rejected": return "text-accent-fail";
    default: return "text-accent-focus";
  }
}

function childrenOf(tools: ToolCallView[], parentCallId: string | null): ToolCallView[] {
  return tools.filter((tool) => (tool.parentCallId ?? null) === parentCallId);
}

export default function ToolFold({ tools }: ToolFoldProps) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1];
  const summary = last?.summary ?? "";
  const label = `工具调用 · ${tools.length} 次`;
  const HeaderIcon = last ? iconFor(last.name) : OctagonAlert;

  return (
    <div className="flex min-w-0 flex-col" data-tool-fold="">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-6 min-w-0 w-full items-center gap-1.5 overflow-hidden text-left"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
          {open ? <ChevronDown size={14} strokeWidth={1.8} aria-hidden /> : <HeaderIcon size={14} strokeWidth={1.8} aria-hidden />}
        </span>
        <span className="shrink-0 text-sm text-text-muted">{label}</span>
        <span className="mx-1 h-0.5 w-0.5 shrink-0 rounded-[1px] bg-text-caption" />
        <span className="min-w-0 flex-1 truncate text-sm text-text-faint">{summary}</span>
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col gap-1 py-1 pl-[22px]" data-tool-rows="">
          {childrenOf(tools, null).map((tool, index) => (
            <ToolTree key={`${tool.callId ?? tool.name}-${index}`} tool={tool} tools={tools} depth={0} />
          ))}
          {tools.length > 0 && childrenOf(tools, null).length === 0 ? tools.map((tool, index) => (
            <ToolTree key={`${tool.callId ?? tool.name}-orphan-${index}`} tool={tool} tools={tools} depth={0} />
          )) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolTree({ tool, tools, depth }: { tool: ToolCallView; tools: ToolCallView[]; depth: number }) {
  const children = tool.callId ? childrenOf(tools, tool.callId) : [];
  return (
    <div style={{ paddingLeft: `${Math.min(depth, 4) * 12}px` }}>
      <div
        className="ds-tool-row flex min-w-0 flex-col"
        data-tool-name={tool.name}
        data-tool-status={tool.status}
        data-tool-parent={tool.parentCallId ?? undefined}
      >
        {/** Error prose lives in the dedicated error line below; keep the
         * one-line row compact instead of duplicating it verbatim. */}
        {(() => {
          const rowSummary = tool.status === "rejected" && tool.error ? "调用被拒绝" : tool.summary;
          return (
            <>
              <div className="flex h-6 min-w-0 items-center gap-1.5 text-[13px] leading-6">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-tool-icon={tool.name}>
                  <LeadingIcon tool={tool} />
                </span>
                <span className="shrink-0 text-text-muted">{titleFor(tool.name)}</span>
                <span className="mx-1 h-0.5 w-0.5 shrink-0 rounded-[1px] bg-text-caption" />
                <span className="min-w-0 flex-1 truncate text-text-faint">{rowSummary}</span>
                <span className={`shrink-0 text-[11px] ${statusClass(tool.status)}`}>
                  {STATUS_LABEL[tool.status]}
                </span>
                {tool.durationMs != null ? <span className="shrink-0 text-[11px] text-text-caption">{Math.round(tool.durationMs)}ms</span> : null}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5 pb-1 pl-[22px] text-sm leading-5 text-text-faint">
                <div className="font-mono text-[12px] text-text-muted">{tool.name}</div>
                <div className="truncate">参数 {formatArgs(tool.args)}</div>
                <div>结果 {tool.summary}</div>
                {tool.error ? <div className="text-accent-fail">{tool.error}</div> : null}
              </div>
            </>
          );
        })()}
      </div>
      {children.map((child, index) => <ToolTree key={`${child.callId ?? child.name}-child-${index}`} tool={child} tools={tools} depth={depth + 1} />)}
    </div>
  );
}
