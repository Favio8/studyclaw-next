"use client";

/**
 * 右栏功能面板外壳（T3.4；v1.4 视觉随全局 DSH 化：下划线 Tab 条）。
 *
 * 顶部图标 Tab 条（Ctrl+1~4 快捷键由 useKeyboardShortcuts 处理）；
 * 新事件角标 `●`（badges，查看即清除）；四 Tab **常驻挂载**、非活动
 * `hidden` 隐藏——切 Tab 不丢评测中/数据状态。
 */

import ProgressTab from "@/src/components/panel/ProgressTab";
import SyllabusTab from "@/src/components/panel/SyllabusTab";
import HeatmapTab from "@/src/components/panel/HeatmapTab";
import QuizTab from "@/src/components/panel/QuizTab";
import AgentRuntimePanel from "@/src/components/panel/AgentRuntimePanel";
import { useAppStore } from "@/src/store/useAppStore";
import type { PanelTab } from "@/src/store/useAppStore";
import { BarChart3, Flame, Map, PanelRightClose, Target } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const TABS: Array<{ id: PanelTab; icon: LucideIcon; label: string }> = [
  { id: "progress", icon: BarChart3, label: "进度" },
  { id: "syllabus", icon: Map, label: "大纲" },
  { id: "heatmap", icon: Flame, label: "热力" },
  { id: "quiz", icon: Target, label: "题卡" },
];

export default function RightPanel() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const badges = useAppStore((s) => s.badges);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);

  return (
    <div
      data-focus-zone="right"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col gap-3 bg-bg-root/45 px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
    >
      {/* 头部：Tab 条 + 折叠钮（收进去把宽度让给中栏对话；Ctrl+B 同效） */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div role="tablist" aria-label="学习面板" className="grid flex-1 grid-cols-4 gap-0.5 rounded-lg border border-border-line bg-bg-card p-1">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`panel-${tab.id}`}
              title={`${tab.label}（Ctrl+${TABS.indexOf(tab) + 1}）`}
              onClick={() => setActiveTab(tab.id)}
              aria-current={active ? "page" : undefined}
              className={`relative flex h-8 min-w-0 items-center justify-center gap-1 rounded-md px-1 text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
                active
                  ? "bg-bg-panel font-medium text-accent-focus shadow-[0_1px_2px_rgba(15,17,21,0.08)]"
                  : "text-text-muted hover:bg-bg-panel/70 hover:text-text-primary"
              }`}
            >
              <Icon size={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="truncate">{tab.label}</span>
              {badges[tab.id] && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-focus ring-2 ring-bg-panel"
                  title="有新事件"
                />
              )}
            </button>
          );
        })}
        </div>
        <button
          type="button"
          aria-label="折叠右栏"
          title="折叠右栏（Ctrl+B）"
          onClick={() => setRightPanelCollapsed(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        >
          <PanelRightClose size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5 [scrollbar-gutter:stable]">
        <AgentRuntimePanel />
        <div className="h-2" aria-hidden />
        <div id="panel-progress" role="tabpanel" aria-labelledby="tab-progress" aria-label="进度" className={activeTab === "progress" ? "" : "hidden"}>
          <ProgressTab />
        </div>
        <div id="panel-syllabus" role="tabpanel" aria-labelledby="tab-syllabus" aria-label="大纲" className={activeTab === "syllabus" ? "" : "hidden"}>
          <SyllabusTab />
        </div>
        <div id="panel-heatmap" role="tabpanel" aria-labelledby="tab-heatmap" aria-label="热力" className={activeTab === "heatmap" ? "" : "hidden"}>
          <HeatmapTab />
        </div>
        <div id="panel-quiz" role="tabpanel" aria-labelledby="tab-quiz" aria-label="题卡" className={activeTab === "quiz" ? "" : "hidden"}>
          <QuizTab />
        </div>
      </div>
    </div>
  );
}
