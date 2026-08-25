/**
 * 四学习模式常量与标签（T3.3 从 Header 抽出共享：顶栏切换 / 中栏指令 / 横幅共用）。
 *
 * 与 `src/types/index.ts` 的 LearningMode 枚举 1:1 对齐（API 线上的值）。
 */

import type { LearningMode } from "@/src/types";

export const MODES: Array<{ value: LearningMode; label: string }> = [
  { value: "socratic", label: "苏格拉底" },
  { value: "quick", label: "极速冲刺" },
  { value: "feynman", label: "费曼输出" },
  { value: "debug", label: "实战排错" },
];

/** 模式中文标签（未知值回退苏格拉底）。 */
export function modeLabel(mode: LearningMode | string | undefined | null): string {
  return MODES.find((m) => m.value === mode)?.label ?? "苏格拉底";
}