"use client";

/**
 * DSH StatsLine 复刻：
 * 显示在消息流底部、消息列同轴；
 * 当前 StudyClaw 数据模型能给出 turns/steps/thinking 耗时，时间类字段留空即不渲染。
 */

import type { ChatMessage } from "@/src/store/useAppStore";

interface StatsLineProps {
  messages: ChatMessage[];
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export default function StatsLine({ messages }: StatsLineProps) {
  const turns = messages.filter((m) => m.role === "user").length;
  const steps = messages.filter((m) => m.role === "agent").length;
  const llmMs = messages.reduce((sum, m) => sum + (m.thinkingMs ?? 0), 0);
  if (turns === 0 && steps === 0) return null;

  const groups: string[] = [];
  groups.push(`${turns} turns`);
  if (steps > 0) groups[0] = `${turns} turns · ${steps} steps`;
  if (llmMs > 0) groups.push(`LLM ${formatDuration(llmMs)}`);
  const text = groups.join(" | ");

  return (
    <div className="mx-auto block w-full max-w-[748px] overflow-hidden text-ellipsis whitespace-nowrap px-8 pt-1 text-center text-xs leading-5 text-text-faint">
      {text}
    </div>
  );
}
