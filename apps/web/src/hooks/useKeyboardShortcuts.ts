"use client";

/**
 * 全局键盘快捷键（T3.4 子集 + T3.5 全量，ui_design_spec §5 / PRD §8.3）。
 *
 * - Ctrl/Cmd+1~4 → 右栏 Tab 切换；Ctrl/Cmd+K → Command Palette；
 *   Ctrl/Cmd+N → 当前项目新建对话；
 * - Alt+1~4 → 题卡选项（编辑态不抢键）；
 * - Esc → Palette → 向导 → 失焦 依次关闭；
 * - Tab/Shift+Tab → 三区焦点循环（左栏 → 输入框 → 右栏，弹层开启让位）；
 * - Space → 题卡 done 态下一题（编辑态不抢键）。
 */

import { useEffect } from "react";
import { quizAnswer, quizNext } from "@/src/lib/quizFlow";
import { createNewSession } from "@/src/lib/sessionActions";
import { isModalOpen } from "@/src/lib/modalStack";
import { useAppStore } from "@/src/store/useAppStore";
import type { PanelTab } from "@/src/store/useAppStore";

const TAB_ORDER: PanelTab[] = ["progress", "syllabus", "heatmap", "quiz"];
const ZONE_ORDER = ["left", "input", "right"] as const;
type Zone = (typeof ZONE_ORDER)[number];

function currentZone(): Zone | null {
  const el = document.activeElement as HTMLElement | null;
  const zone = el?.closest?.("[data-focus-zone]")?.getAttribute(
    "data-focus-zone",
  );
  return (ZONE_ORDER as readonly string[]).includes(zone ?? "")
    ? (zone as Zone)
    : null;
}

function focusZone(zone: Zone) {
  const container = document.querySelector(
    `[data-focus-zone="${zone}"]`,
  ) as HTMLElement | null;
  if (!container) return;
  const target =
    zone === "input"
      ? (container.querySelector("textarea") as HTMLElement | null) ?? container
      : container;
  target.focus();
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true;
      const mod = event.ctrlKey || event.metaKey;
      const alt = event.altKey;
      const state = useAppStore.getState();

      // -- 组合键：Ctrl/Cmd -----------------------------------------------
      if (mod && !alt && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "k") {
          // Command Palette。W-10：任意弹层打开（modal 栈非空——设置/材料/
          // 向导/各类确认框，含非 store 的本地弹层）时不叠开 Palette，避免
          // 半叠加态；旧实现只查三个 store 旗标，MaterialsDialog 打开时
          // Ctrl+K 仍会叠开。
          if (isModalOpen()) return;
          event.preventDefault();
          state.setPaletteOpen(!state.paletteOpen);
          return;
        }
        // UI-20：其余 Ctrl 组合键不再穿透弹层——Palette 搜索框里按 Ctrl+N
        // 会静默新建会话、设置弹层里会静默切 Tab。Ctrl+K 留作弹层互斥开关。
        if (state.paletteOpen || isModalOpen()) return;
        if (key === "n") {
          event.preventDefault();
          // UI-22：失败原因（无项目 vs 请求失败）由 createNewSession 内部
          // 以横幅呈现，这里不再统一覆盖为"未选择项目"。
          void createNewSession();
          return;
        }
        const n = Number(event.key);
        if (n >= 1 && n <= 4) {
          event.preventDefault();
          state.setActiveTab(TAB_ORDER[n - 1]);
        }
        return; // 其余 Ctrl/Cmd 组合不劫持
      }

      // -- 组合键：Alt -----------------------------------------------------
      if (alt && !mod) {
        if (inEditable) return;
        const n = Number(event.key);
        const task = state.quiz.tasks[state.quiz.index];
        if (
          state.activeTab === "quiz" &&
          n >= 1 &&
          n <= 4 &&
          task?.options &&
          state.quiz.phase === "idle"
        ) {
          const option = task.options[n - 1];
          if (option) {
            event.preventDefault();
            void quizAnswer(option);
          }
        }
        return;
      }

      // -- 无修饰键 ---------------------------------------------------------
      if (event.key === "Escape") {
        if (state.paletteOpen) {
          event.preventDefault();
          state.setPaletteOpen(false);
          return;
        }
        if (state.wizardOpen) {
          event.preventDefault();
          state.setWizardOpen(false);
          return;
        }
        if (inEditable) {
          event.preventDefault();
          (target as HTMLElement).blur();
        }
        return;
      }

      if (event.key === "Tab") {
        // UI-12：设置弹层同为模态——Tab 必须在弹层内部导航，不能被三区
        // 焦点循环劫持（此前焦点会逃逸到背景三区）。
        // W-10：判定改查 modal 栈（isModalOpen）——覆盖材料/向导/确认框等
        // 非 store 本地弹层；弹层内的循环由 useFocusTrap 的 capture 处理器
        // 负责（边界 preventDefault），中段交由浏览器原生 Tab。
        if (state.paletteOpen || isModalOpen()) return; // 弹层让位原生 Tab
        event.preventDefault();
        const zone = currentZone() ?? "left";
        const delta = event.shiftKey ? -1 : 1;
        const idx = ZONE_ORDER.indexOf(zone);
        const next =
          ZONE_ORDER[(idx + delta + ZONE_ORDER.length) % ZONE_ORDER.length];
        focusZone(next);
        return;
      }

      if (event.code === "Space" && !inEditable) {
        if (state.activeTab === "quiz" && state.quiz.phase === "done") {
          // UI-21：焦点落在可交互控件（按钮/会话行等）时让位原生激活——
          // 此前焦点在任意按钮上按 Space 都会被劫持成"下一题"。
          if (target?.closest("button, a, [role='treeitem'], [role='tab'], [role='menuitem']")) return;
          event.preventDefault();
          void quizNext();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}