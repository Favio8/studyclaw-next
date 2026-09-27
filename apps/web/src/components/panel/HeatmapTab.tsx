"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarDays, Check, Flame, History, MousePointer2, X } from "lucide-react";
import { api } from "@/src/lib/api";
import { buildHeatmapGrid } from "@/src/lib/heatmapGrid";
import { useAppStore } from "@/src/store/useAppStore";
import type { HeatmapDay, HeatmapDayDetail } from "@/src/types/api";
import {
  PanelSection,
  PanelSkeleton,
  StatusPill,
  panelSurfaceClass,
} from "@/src/components/panel/PanelPrimitives";

const LEVEL_CELL_CLASS = [
  "bg-bg-card border-border-line/50",
  "bg-accent-focus/20 border-accent-focus/20",
  "bg-accent-focus/50 border-accent-focus/35",
  "bg-accent-focus border-accent-focus",
];

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export default function HeatmapTab() {
  const heatmap = useAppStore((s) => s.heatmap);
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [detail, setDetail] = useState<HeatmapDayDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // W-7：回放详情归属打开时的课程——切项目后旧课程的回放不得继续渲染在新
  // 课程下（新 heatmap 到达时旧 detail 会重新挂载出现）。
  useEffect(() => {
    setDetail(null);
  }, [activeCourseId]);

  if (!heatmap) return <PanelSkeleton lines={3} />;

  async function openDay(date: string) {
    setDetailLoading(true);
    try {
      setDetail(await api.heatmapDay(date));
    } catch {
      setDetail({ date, changelog: [], events: [] });
    } finally {
      setDetailLoading(false);
    }
  }

  if (detail) {
    return (
      <div className="space-y-4 pb-2">
        <PanelSection title="学习回放" icon={History} action={<StatusPill tone="neutral">{detail.date}</StatusPill>}>
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-line px-2.5 text-[12px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <ArrowLeft size={14} strokeWidth={1.8} aria-hidden />
            返回热力图
          </button>
        </PanelSection>

        <PanelSection title="变更记录" icon={History}>
          {detail.changelog.length === 0 ? (
            <div className={`${panelSurfaceClass} p-3 text-[12px] text-text-faint`}>当天没有学习记录。</div>
          ) : (
            <div className={`${panelSurfaceClass} divide-y divide-border-line/70 overflow-hidden`}>
              {detail.changelog.map((line, index) => (
                <div key={index} className="break-words px-3 py-2 text-[11px] leading-5 text-text-muted">
                  {line}
                </div>
              ))}
            </div>
          )}
        </PanelSection>

        {detail.events.length > 0 ? (
          <PanelSection title="学习事件" icon={CalendarDays}>
            <div className={`${panelSurfaceClass} divide-y divide-border-line/70 overflow-hidden`}>
              {detail.events.map((event, index) => (
                <div key={index} className="flex min-w-0 items-center gap-2 px-3 py-2 text-[11px]">
                  {event.passed ? (
                    <Check size={14} strokeWidth={2} className="shrink-0 text-accent-pass" aria-label="通过" />
                  ) : (
                    <X size={14} strokeWidth={2} className="shrink-0 text-accent-fail" aria-label="未通过" />
                  )}
                  <span className="shrink-0 text-text-muted">{event.type}</span>
                  <span className="min-w-0 truncate text-text-faint">{event.taskId ?? "未关联题目"}</span>
                </div>
              ))}
            </div>
          </PanelSection>
        ) : null}
      </div>
    );
  }

  const hovered = hoverDate ? heatmap.days.find((day) => day.date === hoverDate) : null;
  // 日期驱动的网格：列=周、行=星期几，首格落在首日真实星期位（修复旧
  // 「每 7 个数据切一列」导致的日期散乱分布），未来日期天然不渲染。
  const grid = buildHeatmapGrid(heatmap.days);

  return (
    <div className="space-y-4 pb-2">
      <PanelSection title="学习热力" icon={Flame} action={<StatusPill tone={heatmap.streak.current > 0 ? "focus" : "neutral"}>{heatmap.weeks} 周</StatusPill>}>
        <div className={`${panelSurfaceClass} p-3`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-focus/10 text-accent-focus">
                <Flame size={17} strokeWidth={1.8} aria-hidden />
              </span>
              <div>
                <p className="text-[11px] text-text-muted">连续学习</p>
                <p className="text-base font-semibold text-text-primary">{heatmap.streak.current} 天</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-text-faint">最长连续</p>
              <p className="mt-0.5 text-[13px] font-medium text-text-primary">{heatmap.streak.best} 天</p>
            </div>
          </div>
          <div className="mt-3 flex min-h-7 items-center gap-2 rounded-md bg-bg-root px-2 text-[11px] text-text-muted">
            <MousePointer2 size={13} strokeWidth={1.8} className="shrink-0 text-text-faint" aria-hidden />
            {hovered ? (
              <span className="truncate text-accent-focus">{hovered.date} · {hovered.tasks} 次答题 · {hovered.chatTurns} 轮对话 · 得分 {hovered.score}</span>
            ) : (
              <span className="truncate">近 {heatmap.weeks} 周的学习活动</span>
            )}
          </div>
        </div>
      </PanelSection>

      <PanelSection title="每日活动" icon={CalendarDays}>
        <div className={`${panelSurfaceClass} overflow-x-auto p-3`}>
          <div className="mx-auto w-fit min-w-[230px]">
            {/* 月份标签行：与数据列同宽同距 */}
            <div className="mb-1 flex gap-1 pl-4">
              {grid.columns.map((column, columnIndex) => (
                <div key={columnIndex} className="w-3.5 overflow-visible whitespace-nowrap text-left text-[9px] leading-none text-text-faint">
                  {column.monthLabel ?? ""}
                </div>
              ))}
            </div>
            <div className="flex gap-1">
              {/* 星期标签列 */}
              <div className="flex shrink-0 flex-col gap-1 pr-0.5">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label} className="flex h-3.5 w-3 items-center justify-end text-[9px] leading-none text-text-faint">{label}</span>
                ))}
              </div>
              {/* 数据网格：列=周，行=星期几 */}
              {grid.columns.map((column, columnIndex) => (
                <div key={columnIndex} className="flex flex-col gap-1">
                  {column.cells.map((cell, rowIndex) => {
                    if (cell === null || cell.day === null) {
                      return <span key={rowIndex} className="h-3.5 w-3.5 rounded-[3px] opacity-0" aria-hidden />;
                    }
                    const day = cell.day;
                    return (
                      <button
                        key={cell.date}
                        type="button"
                        title={`${cell.date} · ${day.tasks} 次答题`}
                        aria-label={`${cell.date}，${day.tasks} 次答题`}
                        onClick={() => void openDay(day.date)}
                        onMouseEnter={() => setHoverDate(day.date)}
                        onMouseLeave={() => setHoverDate(null)}
                        className={`h-3.5 w-3.5 rounded-[3px] border transition-transform duration-100 hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${LEVEL_CELL_CLASS[day.level] ?? LEVEL_CELL_CLASS[0]}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-text-faint">
            <span>少</span>
            {LEVEL_CELL_CLASS.map((className, index) => <span key={index} className={`h-2.5 w-2.5 rounded-[2px] border ${className}`} aria-hidden />)}
            <span>多</span>
          </div>
        </div>
      </PanelSection>

      {detailLoading ? <p className="animate-pulse text-[11px] text-accent-focus">正在加载当日记录…</p> : null}
    </div>
  );
}
