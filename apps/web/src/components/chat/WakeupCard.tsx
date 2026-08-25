"use client";

/**
 * 学习中断唤醒卡（F6）。
 *
 * 恢复/新建对话时顶栏展示 1 道快问快答（来自后端 restore/new 响应的
 * `wakeup` 字段）：
 * - 「作答」：内联输入 → 走既有 eval SSE 闭环（SM-2 重排期 + 三处回写）；
 * - 「跳过」：直接关闭（不打断既有流，不触发任何 SSE）；
 * - 「下次再测」：即作答后遗留的唤醒态可手动收起。
 */

import { useCallback, useState } from "react";
import { submitWakeupAnswer } from "@/src/lib/wakeup";
import { useAppStore } from "@/src/store/useAppStore";
import type { WakeupCard as WakeupCardType } from "@/src/types/api";

export default function WakeupCard({ card }: { card: WakeupCardType }) {
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const setWakeupCard = useAppStore((s) => s.setWakeupCard);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    passed: boolean;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const skip = useCallback(() => {
    setWakeupCard(null);
  }, [setWakeupCard]);

  const submit = useCallback(async () => {
    if (!activeCourseId || !answer.trim()) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await submitWakeupAnswer(activeCourseId, card.taskId, answer.trim());
      setFeedback({
        passed: result.passed,
        text: result.passed
          ? `✓ 唤醒快问答对（得分 ${Math.round(result.score * 100)}%）`
          : `✗ 未命中：${result.feedback || "看看复习提示"}（下次复习 ${result.nextReviewAt ?? "-"}）`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "评测失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }, [activeCourseId, answer, card.taskId]);

  return (
    <div className="mb-2 rounded-xl border border-accent-focus/30 bg-bg-card/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-accent-focus">唤醒快问快答</span>
        <button
          type="button"
          onClick={skip}
          className="text-[12px] text-text-faint transition-colors hover:text-text-primary"
        >
          跳过
        </button>
      </div>
      <p className="mt-1.5 text-[14px] leading-6 text-text-primary">{card.question}</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          aria-label="唤醒快问答作"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void submit();
          }}
          placeholder="打字作答，Enter 提交"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border-line bg-bg-panel px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
        />
        <button
          type="button"
          disabled={busy || !answer.trim()}
          onClick={() => void submit()}
          className="h-8 shrink-0 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "评测中…" : "作答"}
        </button>
      </div>
      {feedback ? (
        <p
          role="status"
          className={`mt-2 text-[13px] leading-5 ${feedback.passed ? "text-accent-pass" : "text-accent-fail"}`}
        >
          {feedback.text}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-accent-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
