"use client";

/**
 * F2：概念补题入口（覆盖统计 + 前置条件 + 真实进度 + 逐概念结果 + 停止/重试）。
 *
 * 只补「已采用 AI 概念、当前无有效题卡」的概念；点击前先解释条件，成功/部分
 * 成功/停止都如实展示。跨 Tab 共享 store 状态（ProgressTab / SyllabusTab /
 * ReaderView 同时挂载），异步编排在 lib/conceptFillFlow.ts。
 *
 * `variant`：
 * - `panel`（右栏进度/大纲）：多行卡片，含覆盖说明、运行明细与结果详情；
 * - `toolbar`（阅读工具条）：严格单行——说明与明细收进 `title`，避免把单行
 *   工具条撑成两行导致与旁边控件对不齐。
 */

import { useEffect, useState } from "react";
import { ChevronDown, CircleCheck, CircleX, Loader2, Play, RefreshCw, Settings2, Sparkles, Square } from "lucide-react";
import {
  loadConceptCardStatus,
  retryConceptFill,
  startConceptFill,
  stopConceptFill,
} from "@/src/lib/conceptFillFlow";
import { openConceptDialog } from "@/src/lib/conceptDialog";
import { quizLoad } from "@/src/lib/quizFlow";
import { useAppStore } from "@/src/store/useAppStore";
import type { ConceptFillItemStatus } from "@/src/types/api";

const ITEM_LABEL: Record<ConceptFillItemStatus, string> = {
  pending: "待处理",
  running: "处理中",
  filled: "已补齐",
  covered: "已覆盖，跳过",
  failed: "失败",
  unprocessed: "未处理",
};

export default function ConceptCardFill({ variant = "panel" }: { variant?: "panel" | "toolbar" }) {
  const toolbar = variant === "toolbar";
  const courseId = useAppStore((s) => s.activeCourseId);
  const status = useAppStore((s) => s.conceptCardStatus);
  const fill = useAppStore((s) => s.conceptFill);
  const revision = useAppStore((s) => s.courseDataRevision);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    void loadConceptCardStatus();
  }, [courseId, revision]);

  if (courseId === null) return null;

  function openModelSettings() {
    setSettingsSection("models");
    setSettingsOpen(true);
  }

  function startPractice() {
    useAppStore.getState().setCenterView("chat");
    useAppStore.getState().setActiveTab("quiz");
    useAppStore.getState().setRightPanelCollapsed(false);
    void quizLoad("new");
  }

  // 工具条模式下把完整说明挂到 title，避免多出一行说明把工具条撑高。
  const coverageHint = status === null
    ? "正在读取题卡覆盖…"
    : !status.modelReady
      ? "补齐题卡需要先配置模型（设置 → 模型配置）"
      : status.conceptOrigin !== "semantic"
        ? "先确认学习概念，再补齐题卡（全课范围）"
        : status.missingConcepts === 0
          ? `全课范围：题卡已覆盖全部 ${status.totalConcepts} 个概念`
          : `全课范围：已覆盖 ${status.coveredConcepts}/${status.totalConcepts} 个概念，还有 ${status.missingConcepts} 个缺题；只为缺题概念生成，每个概念默认 2 张`;

  // 正在运行：显示当前任务、已完成/总概念数、已新增张数，支持停止。
  if (fill.courseId === courseId && fill.status === "running") {
    const progressText = `${fill.currentConcept ? `正在为「${fill.currentConcept}」出题` : "正在准备…"} · ${fill.processed}/${fill.total} 个概念 · 已新增 ${fill.generated} 张`;
    const stopButton = (
      <button
        type="button"
        onClick={() => void stopConceptFill()}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border-line px-1.5 text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
      >
        <Square size={11} strokeWidth={2} aria-hidden />
        停止
      </button>
    );
    const spinner = <Loader2 size={13} strokeWidth={1.8} className="shrink-0 animate-spin text-accent-focus" aria-hidden />;
    if (toolbar) {
      return (
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap" data-testid="concept-fill-progress">
          {spinner}
          <span className="min-w-0 max-w-[280px] truncate text-text-primary" title={progressText}>{progressText}</span>
          {stopButton}
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-border-line bg-bg-card/50 p-2.5 text-[12px] leading-5" data-testid="concept-fill-progress">
        <div className="flex items-center gap-2">
          {spinner}
          <span className="min-w-0 flex-1 truncate text-text-primary">{progressText}</span>
          {stopButton}
        </div>
        {fill.items.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {fill.items.filter((item) => item.status !== "covered").map((item) => (
              <li key={item.conceptId} className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-text-faint">{ITEM_LABEL[item.status]}{item.generated > 0 ? ` · ${item.generated} 张` : ""}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const finished = fill.courseId === courseId && (fill.status === "done" || fill.status === "stopped" || fill.status === "failed");
  const failedCount = fill.items.filter((item) => item.status === "failed").length;
  const unprocessedCount = fill.items.filter((item) => item.status === "unprocessed").length;
  const filledConcepts = fill.items.filter((item) => item.status === "filled").length;
  const allFailed = fill.status === "failed" && fill.items.every((item) => item.status !== "filled");
  const resultText = fill.status === "stopped"
    ? `已停止，已保存 ${fill.generated} 张题卡`
    : allFailed
      ? `补题失败：${fill.error ?? fill.sharedProblem ?? "未知原因"}`
      : `为 ${filledConcepts} 个概念新增 ${fill.generated} 张题卡`;
  const resultIcon = allFailed
    ? <CircleX size={13} strokeWidth={1.8} className="shrink-0 text-accent-fail" aria-hidden />
    : <CircleCheck size={13} strokeWidth={1.8} className="shrink-0 text-accent-pass" aria-hidden />;

  return (
    <div
      className={toolbar ? "flex min-w-0 items-center gap-2 whitespace-nowrap" : "flex flex-col gap-1.5"}
      data-testid="concept-fill"
      title={toolbar ? coverageHint : undefined}
    >
      <div className={toolbar ? "flex items-center gap-2" : "flex flex-wrap items-center gap-2"}>
        <button
          type="button"
          onClick={() => openConceptDialog()}
          className="rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus"
        >
          AI 概念提炼
        </button>
        {status === null ? (
          <span className="text-[11px] text-text-faint">正在读取题卡覆盖…</span>
        ) : !status.modelReady ? (
          <>
            <span className="text-[11px] text-text-muted">补齐题卡需要模型配置</span>
            <button
              type="button"
              onClick={openModelSettings}
              className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus"
            >
              <Settings2 size={12} strokeWidth={1.8} aria-hidden />
              配置模型
            </button>
          </>
        ) : status.conceptOrigin !== "semantic" ? (
          <>
            <span className="text-[11px] text-text-muted">请先确认学习概念，再补齐题卡</span>
            <button
              type="button"
              onClick={() => openConceptDialog()}
              className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus"
            >
              <Sparkles size={12} strokeWidth={1.8} aria-hidden />
              AI 概念提炼
            </button>
          </>
        ) : status.missingConcepts === 0 ? (
          <>
            <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
              <CircleCheck size={12} strokeWidth={1.8} className="text-accent-pass" aria-hidden />
              题卡已覆盖全部 {status.totalConcepts} 个概念
            </span>
            <button
              type="button"
              onClick={startPractice}
              className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus"
            >
              <Play size={11} strokeWidth={2} aria-hidden />
              开始练习
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void startConceptFill()}
            className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-xs text-accent-focus"
          >
            <Sparkles size={12} strokeWidth={1.8} aria-hidden />
            补齐概念题卡（{status.missingConcepts}）
          </button>
        )}
      </div>

      {!toolbar && status !== null && status.totalConcepts > 0 ? (
        <p className="text-[11px] text-text-faint">
          已覆盖 {status.coveredConcepts}/{status.totalConcepts} 个概念 · {status.missingConcepts} 个缺题
          {status.missingConcepts > 0 ? "，只为缺题概念生成" : "，全部概念已有题卡"}
        </p>
      ) : null}

      {finished ? (
        toolbar ? (
          <div className="flex min-w-0 items-center gap-2 whitespace-nowrap" data-testid="concept-fill-result">
            {resultIcon}
            <span className="min-w-0 max-w-[320px] truncate text-text-primary" title={fill.sharedProblem ?? resultText}>{resultText}</span>
            {status !== null && status.missingConcepts > 0 ? (
              <button
                type="button"
                onClick={() => void retryConceptFill()}
                className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-[11px] text-accent-focus"
              >
                <RefreshCw size={11} strokeWidth={1.8} aria-hidden />
                重试
              </button>
            ) : null}
            {fill.generated > 0 ? (
              <button
                type="button"
                onClick={startPractice}
                className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-[11px] text-accent-focus"
              >
                <Play size={11} strokeWidth={2} aria-hidden />
                开始练习
              </button>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-border-line bg-bg-card/50 p-2.5 text-[12px] leading-5" data-testid="concept-fill-result">
            <div className="flex items-center gap-2">
              {resultIcon}
              <span className="min-w-0 flex-1 text-text-primary">{resultText}</span>
            </div>
            {failedCount + unprocessedCount > 0 ? (
              <p className="mt-1 text-[11px] text-text-muted">
                {failedCount > 0 ? `${failedCount} 个失败` : ""}{failedCount > 0 && unprocessedCount > 0 ? "、" : ""}{unprocessedCount > 0 ? `${unprocessedCount} 个未处理` : ""}
              </p>
            ) : null}
            {fill.sharedProblem !== null ? <p className="mt-1 text-[11px] text-accent-fail">{fill.sharedProblem}</p> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowDetails((value) => !value)}
                aria-expanded={showDetails}
                className="inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
              >
                <ChevronDown size={12} strokeWidth={1.8} className={showDetails ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden />
                {showDetails ? "收起明细" : "查看明细"}
              </button>
              {status !== null && status.missingConcepts > 0 ? (
                <button
                  type="button"
                  onClick={() => void retryConceptFill()}
                  className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-[11px] text-accent-focus"
                >
                  <RefreshCw size={11} strokeWidth={1.8} aria-hidden />
                  重试剩余缺题概念
                </button>
              ) : null}
              {fill.generated > 0 ? (
                <button
                  type="button"
                  onClick={startPractice}
                  className="inline-flex items-center gap-1 rounded-md border border-border-line px-2 py-1 text-[11px] text-accent-focus"
                >
                  <Play size={11} strokeWidth={2} aria-hidden />
                  开始练习
                </button>
              ) : null}
            </div>
            {showDetails ? (
              <ul className="mt-1.5 space-y-0.5">
                {fill.items.filter((item) => item.status !== "covered").map((item) => (
                  <li key={item.conceptId} className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="shrink-0 text-text-faint">{ITEM_LABEL[item.status]}{item.generated > 0 ? ` · ${item.generated} 张` : ""}</span>
                    {item.reason !== null ? <span className="max-w-[45%] shrink-0 truncate text-accent-fail" title={item.reason}>{item.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
