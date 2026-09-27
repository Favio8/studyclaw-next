/**
 * 学习中断唤醒（F6）：唤醒卡作答走既有评测闭环。
 *
 * `submitWakeupAnswer` 复用 `api.evalSubmit`（SSE 六帧：scan→rubric×N→
 * result→sm2→done），返回最终判定结果；作答后按常规评测结算（SM-2 重排期 +
 * 三处回写），与中栏 QuizTab 完全同一条链路。
 *
 * W-1：与 quizFlow 同口径——evalId（内容指纹）让 SSE 中断后的重试命中服务端
 * 幂等账本、重放已结算帧而不是二次计分；signal 让切项目/移除项目能中止在途
 * 流（旧实现三参全不传：重试二次结算 SM-2/进度，且流不可中止）。
 */

import { api } from "@/src/lib/api";
import { refreshCourseList, refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";

export interface WakeupEvalResult {
  passed: boolean;
  score: number;
  feedback: string;
  misconceptions: string[];
  nextReviewAt: string | null;
  masteryDelta: number;
}

/** 模块级「唤醒卡评测流」中止句柄（单例，与 quizFlow 的 activeAbort 同定位）：
 *  切项目/移除项目/组件卸载时先 abort，AbortError 不视为错误。 */
let activeAbort: AbortController | null = null;

/** 中止在途的唤醒卡评测（幂等）。 */
export function abortActiveWakeupEval(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/** UI-7/W-1：作答幂等指纹（课程+题卡+会话+作答内容）。答案变化生成新键，
 *  同一作答的重试复用同键 → 服务端重放已结算帧，不重复 settle 计分。 */
function evalFingerprint(courseId: string, taskId: string, sessionId: string | null, answer: string): string {
  let hash = 5381;
  for (let i = 0; i < answer.length; i += 1) {
    hash = ((hash << 5) + hash) + answer.charCodeAt(i) | 0;
  }
  return `ev_${courseId}_${taskId}_${sessionId ?? "none"}_${(hash >>> 0).toString(36)}_${answer.length}`;
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
  const sessionId = useAppStore.getState().activeSessionId;
  const abort = new AbortController();
  activeAbort = abort;
  try {
    const evalId = evalFingerprint(courseId, taskId, sessionId, answer);
    for await (const event of api.evalSubmit(courseId, taskId, answer, sessionId, abort.signal, evalId)) {
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
  } finally {
    // 中止/结束都清句柄；AbortError 原样上抛由组件识别（切项目不报错）。
    if (activeAbort === abort) activeAbort = null;
  }
  await Promise.all([refreshPanelData(), refreshCourseList()]);
  return result;
}
