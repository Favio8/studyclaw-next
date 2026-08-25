/**
 * 学习中断唤醒（F6）：唤醒卡作答走既有评测闭环。
 *
 * `submitWakeupAnswer` 复用 `api.evalSubmit`（SSE 六帧：scan→rubric×N→
 * result→sm2→done），返回最终判定结果；作答后按常规评测结算（SM-2 重排期 +
 * 三处回写），与中栏 QuizTab 完全同一条链路。
 */

import { api } from "@/src/lib/api";
import { refreshCourseList, refreshPanelData } from "@/src/lib/panelData";

export interface WakeupEvalResult {
  passed: boolean;
  score: number;
  feedback: string;
  misconceptions: string[];
  nextReviewAt: string | null;
  masteryDelta: number;
}

export async function submitWakeupAnswer(
  courseId: string,
  taskId: string,
  answer: string,
): Promise<WakeupEvalResult> {
  const result: WakeupEvalResult = {
    passed: false,
    score: 0,
    feedback: "",
    misconceptions: [],
    nextReviewAt: null,
    masteryDelta: 0,
  };
  for await (const event of api.evalSubmit(courseId, taskId, answer)) {
    if (event.event === "result") {
      result.passed = Boolean(event.data.passed);
      result.score = event.data.score ?? 0;
      result.feedback = event.data.feedback ?? "";
      result.misconceptions = event.data.misconceptions ?? [];
    } else if (event.event === "sm2") {
      result.nextReviewAt = event.data.nextReviewAt ?? null;
      result.masteryDelta = event.data.masteryDelta ?? 0;
    } else if (event.event === "error") {
      throw new Error(event.data.message ?? "唤醒卡评测失败");
    }
  }
  await Promise.all([refreshPanelData(), refreshCourseList()]);
  return result;
}
