"use client";

/**
 * 对话即出题（F4）：把聊天中划选的精妙段落转成永久复习卡片。
 *
 * - 调用后端 `POST /courses/{id}/cards`（api_spec §6.5），复用 TaskGenerator
 *   生成合规题卡并写入 tasks/ 池，quiz 立即可拉取；
 * - LLM 不可用（后端 LLM_UNAVAILABLE）时返回明确降级提示，不抛未捕获异常；
 * - 失败不污染会话流（不调用 chat SSE），与评测闭环完全解耦。
 */

import { useCallback, useState } from "react";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { HarnessTask } from "@/src/types";

export interface InstantCardFeedback {
  busy: boolean;
  ok: boolean;
  message: string;
  task: HarnessTask | null;
}

export default function useInstantCard() {
  const activeCourseId = useAppStore((s) => s.activeCourseId);

  const [feedback, setFeedback] = useState<InstantCardFeedback>({
    busy: false,
    ok: false,
    message: "",
    task: null,
  });

  const create = useCallback(
    async (content: string, title?: string, conceptId?: string): Promise<InstantCardFeedback> => {
      const snippet = (content ?? "").trim();
      if (!snippet) {
        const failed = { busy: false, ok: false, message: "未选中任何内容，无法生成卡片", task: null };
        setFeedback(failed);
        return failed;
      }
      if (!activeCourseId) {
        const failed = { busy: false, ok: false, message: "请先打开一个课程，再生成复习卡片", task: null };
        setFeedback(failed);
        return failed;
      }
      setFeedback({ busy: true, ok: false, message: "正在生成复习卡片…", task: null });
      try {
        const { tasks } = await api.createCard(activeCourseId, {
          content: snippet,
          title: title?.trim() || snippet.slice(0, 40),
          ...(conceptId ? { conceptId } : {}),
        });
        const task = tasks[0] ?? null;
        const result: InstantCardFeedback = {
          busy: false,
          ok: true,
          message: task
            ? `✓ 已生成复习卡片 ${task.taskId}（难度 ${task.difficulty}，quiz 可拉取）`
            : "✓ 卡片已入池",
          task,
        };
        setFeedback(result);
        return result;
      } catch (cause) {
        const reason =
          cause instanceof ApiError && cause.code === "LLM_UNAVAILABLE"
            ? "✗ 生成失败：LLM 不可用（请检查模型配置/网络），可稍后再试"
            : `✗ 生成失败：${cause instanceof Error ? cause.message : "未知错误"}`;
        const result: InstantCardFeedback = { busy: false, ok: false, message: reason, task: null };
        setFeedback(result);
        return result;
      }
    },
    [activeCourseId],
  );

  return { create, feedback };
}
