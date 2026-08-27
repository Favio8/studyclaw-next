"use client";

import { BarChart3, CalendarClock, CircleHelp, ListChecks, RefreshCw } from "lucide-react";
import { masteryTone, pct, relativeTime } from "@/src/lib/format";
import { useAppStore } from "@/src/store/useAppStore";
import { refreshPanelData } from "@/src/lib/panelData";
import {
  LinearProgress,
  PanelEmptyState,
  PanelErrorState,
  PanelSection,
  PanelSkeleton,
  StatusPill,
  panelSurfaceClass,
} from "@/src/components/panel/PanelPrimitives";

const toneDot: Record<ReturnType<typeof masteryTone>, string> = {
  pass: "bg-accent-pass",
  warn: "bg-accent-warn",
  fail: "bg-accent-fail",
};

function progressTone(value: number): "neutral" | "focus" | "pass" | "warn" | "fail" {
  if (value <= 0) return "neutral";
  const tone = masteryTone(value);
  return tone === "pass" ? "pass" : tone === "warn" ? "warn" : "fail";
}

export default function ProgressTab() {
  const progress = useAppStore((s) => s.progress);
  const progressError = useAppStore((s) => s.progressError);

  // 与大纲 Tab 的错误态对齐：加载失败给出可重试的错误卡，而不是无限骨架屏。
  if (!progress && progressError) {
    return (
      <PanelErrorState
        title="学习进度加载失败"
        description={progressError}
        action={
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-accent-fail/30 px-2 text-[11px] text-accent-fail transition-colors hover:bg-accent-fail/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            onClick={() => void refreshPanelData()}
          >
            <RefreshCw size={12} strokeWidth={1.8} aria-hidden />
            重试
          </button>
        }
      />
    );
  }

  if (!progress) return <PanelSkeleton lines={4} />;

  const overallTone = progressTone(progress.overallMastery);

  return (
    <div className="space-y-4 pb-2">
      <PanelSection title="学习概览" icon={BarChart3}>
        <div className={`${panelSurfaceClass} p-3`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted">总体掌握度</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-text-primary">{pct(progress.overallMastery)}</p>
            </div>
            <StatusPill tone={overallTone === "neutral" ? "neutral" : overallTone}>
              {progress.overallMastery <= 0 ? "等待学习" : overallTone === "pass" ? "掌握良好" : overallTone === "warn" ? "持续巩固" : "需要关注"}
            </StatusPill>
          </div>
          <div className="mt-3">
            <LinearProgress value={progress.overallMastery} tone={overallTone} label="总体掌握度" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-faint">
            <StatusPill tone={progress.dueCount > 0 ? "warn" : "neutral"}>
              <CalendarClock size={12} strokeWidth={1.8} aria-hidden />
              {progress.dueCount > 0 ? `${progress.dueCount} 个待复习` : "暂无待复习"}
            </StatusPill>
            <span>更新于 {progress.lastUpdatedAt ? relativeTime(progress.lastUpdatedAt) : "—"}</span>
          </div>
        </div>
      </PanelSection>

      <PanelSection
        title="概念掌握"
        icon={ListChecks}
        action={<span className="text-[11px] text-text-faint">{progress.concepts.length} 个概念</span>}
      >
        {progress.concepts.length === 0 ? (
          <PanelEmptyState
            icon={CircleHelp}
            title="还没有概念数据"
            description="完成课程构建后，这里会显示每个知识点的掌握度和复习安排。"
          />
        ) : (
          <div className={`${panelSurfaceClass} divide-y divide-border-line/70 overflow-hidden`}>
            {progress.concepts.map((concept) => {
              const tone = masteryTone(concept.mastery);
              return (
                <div key={concept.id} className="px-3 py-2.5 transition-colors hover:bg-bg-card/45">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[tone]}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary" title={concept.name}>
                      {concept.name}
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-text-muted">{pct(concept.mastery)}</span>
                  </div>
                  <div className="mt-2">
                    <LinearProgress value={concept.mastery} tone={concept.mastery <= 0 ? "neutral" : tone} label={`${concept.name} 掌握度`} />
                  </div>
                  <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-text-faint">
                    <span className="truncate">{concept.chapter}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{concept.evals} 次评测</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">下次 {concept.nextReviewAt ?? "待安排"}</span>
                  </div>
                  {concept.misattribution && concept.misattribution !== "无" ? (
                    <p className="mt-1 truncate text-[10px] text-accent-warn" title={concept.misattribution}>
                      需要澄清：{concept.misattribution}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PanelSection>
    </div>
  );
}
