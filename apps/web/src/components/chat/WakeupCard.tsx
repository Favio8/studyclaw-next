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

import { useCallback, useEffect, useState } from "react";
import { abortActiveWakeupEval, submitWakeupAnswer } from "@/src/lib/wakeup";
import { isAbortError } from "@/src/lib/chatStream";
import { Clawzy } from "@/src/components/mascot";
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

  // W-1：组件卸载（切课/切项目/收起）时中止在途评测流——否则服务端继续跑完
  // 计费，且迟到事件会写进已切换项目的 store。
  useEffect(() => () => abortActiveWakeupEval(), []);

  // P1 onboarding 轮换：标题猫随交互轮换 idle → 判题 thinking → 结果 celebrate/encourage
  const mascotState = busy ? "thinking" : feedback === null ? "idle" : feedback.passed ? "celebrate" : "encourage";

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
      // 唤醒评测与 quiz 同享爪爪结果脉冲（celebrate/encourage）
      useAppStore.getState().setMascotPulse({
        at: Date.now(),
        kind: result.passed ? "celebrate" : "encourage",
      });
      setFeedback({
        passed: result.passed,
        text: result.passed
          ? `✓ 唤醒快问答对（得分 ${Math.round(result.score * 100)}%）`
          : `✗ 未命中：${result.feedback || "看看复习提示"}（下次复习 ${result.nextReviewAt ?? "-"}）`,
      });
    } catch (cause) {
      // 切换/收起导致的中止不是失败：静默（quizFlow 同语义）。
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "评测失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }, [activeCourseId, answer, card.taskId]);

  return (
    <div className="mb-2 rounded-xl border border-accent-focus/30 bg-bg-card/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-accent-focus">
          {/* P1：爪爪随作答交互轮换姿态（icon 档，24px） */}
          <Clawzy size={24} tier="icon" state={mascotState} ariaLabel={`爪爪：${mascotState === "idle" ? "唤醒快问快答" : mascotState === "thinking" ? "判题中" : mascotState === "celebrate" ? "答对了" : "再接再厉"}`} />
          唤醒快问快答
        </span>
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
