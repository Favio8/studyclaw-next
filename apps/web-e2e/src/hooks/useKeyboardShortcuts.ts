"use client";

/**
 * 全局键盘快捷键（T3.4 子集 + T3.5 全量，ui_design_spec §5 / PRD §8.3）。
 *
 * - Ctrl/Cmd+1~4 → 右栏 Tab 切换；Ctrl/Cmd+K → Command Palette；
 *   Ctrl/Cmd+N → 当前项目新建会话；
 * - Alt+1~4 → 题卡选项（编辑态不抢键）；
 * - Esc → Palette → 向导 → 失焦 依次关闭；
 * - Tab/Shift+Tab → 三区焦点循环（左栏 → 输入框 → 右栏，弹层开启让位）；
 * - Space → 题卡 done 态下一题（编辑态不抢键）。
 */

import { useEffect } from "react";
import { quizAnswer, quizNext } from "@/src/lib/quizFlow";
import { createNewSession } from "@/src/lib/sessionActions";
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
          // Command Palette（互斥弹层：先关向导）
          event.preventDefault();
          if (state.wizardOpen) state.setWizardOpen(false);
          state.setPaletteOpen(!state.paletteOpen);
          return;
        }
        if (key === "n") {
          event.preventDefault();
          void createNewSession().then((ok) => {
            if (!ok) {
              useAppStore.getState().flashStatusBanner("未选择项目，无法新建会话");
            }
          });
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
        if (state.paletteOpen || state.wizardOpen) return; // 弹层让位原生 Tab
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
          event.preventDefault();
          void quizNext();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}