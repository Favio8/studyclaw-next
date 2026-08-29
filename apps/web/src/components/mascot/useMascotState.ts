"use client";

/**
 * 从全局 store 派生爪爪状态（方案 §4.2 优先级仲裁 + §9 迟滞）。
 *
 * 优先级（高→低）：会话错误 alerting > celebrate 脉冲 > quiz 判题中 thinking
 * > 流式 thinking > 流式 writing > 输入聚焦 listening > idle。
 *
 * - 会话错误取「最后一条 agent 消息」的 error（useChatStream 写入消息卡；
 *   用户重试/新消息会追加无 error 的新占位卡，alerting 自然回落）。
 * - celebrate 是覆盖式脉冲：quizFlow 在答对时写 { at }，本模块只按
 *   2400ms 时间窗判定，超时自动回落，答错路径不接（P1 encourage）。
 * - thinking↔writing 互切有 300ms 迟滞：流式帧交替时防仲裁抖动。
 */

import { useEffect, useState } from "react";
import { useAppStore, type ChatMessage } from "@/src/store/useAppStore";
import type { MascotState } from "./types";

/** celebrate 脉冲有效窗（≈一轮四段 hop 时长）。 */
export const PULSE_WINDOW_MS = 2400;

/** thinking↔writing 互切的迟滞时长。 */
export const STREAM_HYSTERESIS_MS = 300;

export interface MascotStateInputs {
  /** 最后一条 agent 消息是否带 error（alerting 触发源）。 */
  hasError: boolean;
  /** celebrate 脉冲时间戳（Date.now()），null=无脉冲。 */
  pulseAt: number | null;
  /** quiz.phase ∈ {scanning, evaluating} 视为判题中。 */
  quizPhase: string;
  streamPhase: "thinking" | "writing" | null;
  streaming: boolean;
  chatFocus: boolean;
}

/** 纯仲裁函数（§4.2 优先级表，单测全覆盖）。 */
export function deriveMascotState(inputs: MascotStateInputs, now: number): MascotState {
  if (inputs.hasError) return "alerting";
  if (inputs.pulseAt !== null && now - inputs.pulseAt < PULSE_WINDOW_MS) return "celebrate";
  if (inputs.quizPhase === "scanning" || inputs.quizPhase === "evaluating") return "thinking";
  if (inputs.streamPhase === "thinking") return "thinking";
  if (inputs.streaming && inputs.streamPhase === "writing") return "writing";
  if (inputs.chatFocus) return "listening";
  return "idle";
}

function lastAgentHasError(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "agent") return Boolean(message.error);
  }
  return false;
}

export function useMascotState(): MascotState {
  // selector 全部带防御性默认值：宽容部分 mock / 异形 store（测试环境）
  const hasError = useAppStore((s) => lastAgentHasError(s.messages ?? []));
  const pulseAt = useAppStore((s) => (s.mascotPulse ? s.mascotPulse.at : null));
  const quizPhase = useAppStore((s) => s.quiz?.phase ?? "idle");
  const streamPhase = useAppStore((s) => s.streamPhase ?? null);
  const streaming = useAppStore((s) => s.streaming ?? false);
  const chatFocus = useAppStore((s) => s.chatFocus ?? false);

  // SSR/首帧输入全为空值 → 恒为 idle，水合安全（§6-5）
  const target = deriveMascotState(
    { hasError, pulseAt, quizPhase, streamPhase, streaming, chatFocus },
    Date.now(),
  );

  const [stable, setStable] = useState<MascotState>("idle");
  // 脉冲过期无 store 变更时也要触发重算（bump 计数器强制重渲染）
  const [, bumpTick] = useState(0);

  // 仲裁直达：非迟滞对立即切换；thinking↔writing 需在新状态停留 300ms
  useEffect(() => {
    if (target === stable) return;
    const isStreamPair =
      (stable === "thinking" && target === "writing") ||
      (stable === "writing" && target === "thinking");
    if (!isStreamPair) {
      setStable(target);
      return;
    }
    const timer = setTimeout(() => setStable(target), STREAM_HYSTERESIS_MS);
    return () => clearTimeout(timer);
  }, [target, stable]);

  // celebrate 时间窗到点强制重算（脉冲过期无 store 变更时也能回落）
  useEffect(() => {
    if (pulseAt === null) return;
    const remain = pulseAt + PULSE_WINDOW_MS - Date.now();
    if (remain <= 0) return;
    const timer = setTimeout(() => bumpTick((n) => n + 1), remain + 5);
    return () => clearTimeout(timer);
  }, [pulseAt]);

  return stable;
}
