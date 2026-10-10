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

/** 每种对话风格的一句话说明（活动栏风格分组旁常驻，降低选择成本）。 */
export const MODE_DESCRIPTIONS: Record<LearningMode, string> = {
  socratic: "不直接给答案，用线索、反例与反问引导思考",
  quick: "一句话本质 + 3 点关键特性 + 避坑 + 最小示例",
  feynman: "你讲它挑刺，用追问暴露模糊点",
  debug: "真实报错与边缘场景，逐步给线索定位根因",
};

/** 模式中文标签（未知值回退苏格拉底）。 */
export function modeLabel(mode: LearningMode | string | undefined | null): string {
  return MODES.find((m) => m.value === mode)?.label ?? "苏格拉底";
}