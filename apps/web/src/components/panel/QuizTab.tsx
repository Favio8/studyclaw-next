"use client";

import { useEffect } from "react";
import type { CSSProperties } from "react";
import { AlertCircle, Check, CircleHelp, ListChecks, RefreshCw, Send, Target, X } from "lucide-react";
import { pct } from "@/src/lib/format";
import { quizAnswer, quizLoad, quizNext, quizReset, quizRetry } from "@/src/lib/quizFlow";
import { useAppStore } from "@/src/store/useAppStore";
import {
  PanelEmptyState,
  PanelErrorState,
  PanelSection,
  PanelSkeleton,
  SegmentedControl,
  StatusPill,
  panelSurfaceClass,
} from "@/src/components/panel/PanelPrimitives";

function QuizModeControl() {
  const mode = useAppStore((s) => s.quiz.mode);
  return (
    <SegmentedControl
      label="题卡模式"
      value={mode}
      options={[
        { value: "review", label: "复习" },
        { value: "new", label: "新题" },
      ]}
      onChange={(value) => void quizLoad(value)}
    />
  );
}

export default function QuizTab() {
  const courseId = useAppStore((s) => s.activeCourseId);
  const quiz = useAppStore((s) => s.quiz);
  const setQuiz = useAppStore((s) => s.setQuiz);

  useEffect(() => {
    if (!courseId) return;
    quizReset();
    void quizLoad("review");
  }, [courseId]);

  if (!courseId) {
    return <PanelEmptyState icon={Target} title="请选择一个项目" description="激活项目后即可进行复习或开始新的练习。" />;
  }

  if (quiz.loading) return <PanelSkeleton lines={3} />;

  const task = quiz.tasks[quiz.index] ?? null;
  const busy = quiz.phase === "scanning" || quiz.phase === "evaluating";
  const answered = quiz.phase === "done";

  function submitShort() {
    const text = useAppStore.getState().quiz.answerText.trim();
    if (text && !busy && !answered) void quizAnswer(text);
  }

  if (!task) {
    return (
      <div className="space-y-4 pb-2">
        <PanelSection title="即时练习" icon={Target} action={<QuizModeControl />}>
          {quiz.error ? (
            <PanelErrorState
              title="题卡加载失败"
              description={quiz.error}
              action={
                <button
                  type="button"
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-accent-fail/30 px-2 text-[11px] text-accent-fail transition-colors hover:bg-accent-fail/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
                  onClick={() => void quizLoad(quiz.mode)}
                >
                  <RefreshCw size={12} strokeWidth={1.8} aria-hidden />
                  重试
                </button>
              }
            />
          ) : (
            <PanelEmptyState
              icon={CircleHelp}
              title={quiz.mode === "review" ? "暂无待复习题目" : "暂无可解锁的新题"}
              description={quiz.mode === "review" ? "继续学习或完成更多评测后，题目会出现在这里。" : "先完成前置知识点的学习和评测，再开始新题练习。"}
            />
          )}
        </PanelSection>
      </div>
    );
  }

  const isChoice = Array.isArray(task.options) && task.options.length > 0;
  const outcomeTone = !answered || !quiz.result ? "border-border-line" : quiz.result.passed ? "border-accent-pass/35" : "border-accent-fail/35";

  return (
    <div className="space-y-4 pb-2">
      <PanelSection
        title="即时练习"
        icon={Target}
        action={<StatusPill tone="neutral">{quiz.index + 1} / {quiz.tasks.length}</StatusPill>}
      >
        <div className="flex items-center justify-between gap-2">
          <QuizModeControl />
          <StatusPill tone="focus">难度 {Math.max(1, Math.min(5, Math.round(task.difficulty)))}/5</StatusPill>
        </div>
      </PanelSection>

      <section className={`${panelSurfaceClass} relative overflow-hidden border ${outcomeTone}`}>
        {quiz.phase === "scanning" ? (
          <div className="scan-line pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-accent-focus" style={{ "--scan-height": "300px" } as CSSProperties} />
        ) : null}
        <div className="flex items-center gap-2 border-b border-border-line/70 px-3 py-2 text-[11px] text-text-muted">
          <Target size={14} strokeWidth={1.8} className="shrink-0 text-accent-focus" aria-hidden />
          <span className="min-w-0 flex-1 truncate">知识点练习</span>
          <span className="shrink-0 text-text-faint">{task.taskId}</span>
        </div>

        <div className="p-3">
          <p className="text-[14px] leading-6 text-text-primary">{task.question}</p>

          {isChoice ? (
            <div className="mt-3 space-y-1.5">
              {task.options!.map((option, index) => {
                const letter = String.fromCharCode(65 + index);
                const picked = answered && quiz.lastAnswer === option;
                const statusClass = picked
                  ? quiz.result?.passed
                    ? "border-accent-pass/45 bg-accent-pass/8 text-accent-pass"
                    : "border-accent-fail/45 bg-accent-fail/8 text-accent-fail"
                  : "border-border-line bg-bg-panel text-text-muted hover:border-accent-focus/35 hover:bg-accent-focus/5 hover:text-text-primary";
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={busy || answered}
                    onClick={() => void quizAnswer(option)}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus disabled:cursor-not-allowed disabled:opacity-70 ${statusClass}`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-bg-card text-[10px] font-medium text-text-muted">{letter}</span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere] leading-5">{option}</span>
                    <span className="shrink-0 text-[10px] text-text-faint">Alt+{index + 1}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-3">
              <label className="sr-only" htmlFor="quiz-answer">你的回答</label>
              <input
                id="quiz-answer"
                value={quiz.answerText}
                onChange={(event) => setQuiz({ answerText: event.target.value })}
                disabled={busy || answered}
                placeholder="输入你的回答"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    submitShort();
                  }
                }}
                className="h-10 w-full rounded-md border border-border-line bg-bg-root px-3 text-[12px] text-text-primary placeholder:text-text-caption focus:border-accent-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-faint">按 Ctrl + Enter 提交</span>
                <button
                  type="button"
                  disabled={!quiz.answerText.trim() || busy || answered}
                  onClick={submitShort}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent-focus px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-focus-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send size={12} strokeWidth={1.8} aria-hidden />
                  提交
                </button>
              </div>
            </div>
          )}

          {busy ? (
            <div className="mt-3 flex items-center gap-2 rounded-md bg-accent-focus/8 px-2.5 py-2 text-[11px] text-accent-focus">
              <RefreshCw size={13} strokeWidth={1.8} className="shrink-0 animate-spin" aria-hidden />
              {quiz.phase === "scanning" ? "正在检查答案…" : "正在生成评测结果…"}
            </div>
          ) : null}

          {quiz.rubrics.length > 0 ? (
            <div className="mt-3 border-t border-border-line/70 pt-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                <ListChecks size={14} strokeWidth={1.8} aria-hidden />
                评分要点
              </div>
              <div className="space-y-1">
                {quiz.rubrics.map((rubric) => (
                  <div key={rubric.index} className="flex min-w-0 items-start gap-2 rounded-md bg-bg-root px-2 py-1.5 text-[11px]">
                    {rubric.hit ? <Check size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-accent-pass" aria-label="命中" /> : <X size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-accent-fail" aria-label="未命中" />}
                    <span className="min-w-0 [overflow-wrap:anywhere] text-text-muted">{rubric.criterion}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {answered && quiz.result ? (
            <div className={`mt-3 rounded-md border p-3 ${quiz.result.passed ? "border-accent-pass/25 bg-accent-pass/8" : "border-accent-fail/25 bg-accent-fail/8"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={quiz.result.passed ? "pass" : "fail"}>{quiz.result.passed ? "通过" : "待巩固"}</StatusPill>
                <span className="text-[13px] font-medium text-text-primary">得分 {pct(quiz.result.score)}</span>
                {quiz.sm2 ? <span className="text-[10px] text-text-muted">记忆系数 {quiz.sm2.ef} → {quiz.sm2.efNew}</span> : null}
              </div>
              {quiz.result.feedback ? <p className="mt-2 text-[11px] leading-5 text-text-muted">导师建议：{quiz.result.feedback}</p> : null}
              {quiz.sm2?.masteryDelta && quiz.sm2.masteryDelta > 0 ? <p className="mt-1 text-[10px] text-accent-pass">掌握度提升 {pct(quiz.sm2.masteryDelta)}</p> : null}
              {quiz.sm2 ? <p className="mt-1 text-[10px] text-text-faint">下次复习：{quiz.sm2.nextReviewAt}</p> : null}
              <button
                type="button"
                onClick={() => void quizNext()}
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-focus px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-focus-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
              >
                下一题
                <span className="text-white/75">Space</span>
              </button>
            </div>
          ) : null}

          {quiz.error ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-accent-fail/25 bg-accent-fail/8 px-2.5 py-2 text-[11px] text-accent-fail" role="alert">
              <AlertCircle size={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{quiz.error}</span>
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-accent-fail/30 px-2 text-[11px] transition-colors hover:bg-accent-fail/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
                onClick={() => void quizRetry()}
              >
                <RefreshCw size={12} strokeWidth={1.8} aria-hidden />
                重试
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
