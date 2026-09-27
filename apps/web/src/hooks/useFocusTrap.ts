"use client";

/**
 * W-10：aria-modal 弹层的焦点圈闭。
 *
 * 旧实现四个弹层均无 Tab 循环——焦点可逃逸到背景三栏（aria-modal 对屏幕阅读器
 * 声明了模态，键盘用户却能 Tab 出去）；MaterialsDialog/NewProjectWizard 打开时
 * 甚至不初始化焦点。本 hook 统一提供：
 * - 打开时聚焦 [data-autofocus] 或首个可聚焦元素（容器自身兜底）；
 * - Tab/Shift+Tab 在容器内首尾循环，空可聚焦集时 preventDefault 兜底；
 * - Escape 交还调用方（onEscape），尊重各弹层自己的 busy 语义；
 * - 关闭后焦点还原到打开前元素；
 * - 嵌套弹层仅栈顶响应（document capture 阶段，早于全局快捷键处理器）。
 */

import { useEffect, useRef, type RefObject } from "react";
import { isTopModal, popModal, pushModal } from "@/src/lib/modalStack";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableIn(container: HTMLElement): HTMLElement[] {
  // 不依赖布局的可见性判断（offsetParent/getClientRects 在 jsdom 恒空）：
  // hidden 属性、aria-hidden 与 display:none 内联样式三种可判定形态。
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) =>
      !element.hasAttribute("hidden")
      && element.closest("[hidden]") === null
      && element.getAttribute("aria-hidden") !== "true"
      && element.closest("[aria-hidden=\"true\"]") === null
      && getComputedStyle(element).display !== "none",
    );
}

export interface FocusTrapOptions {
  /** 弹层容器（role=dialog 的 section）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** Escape 回调；省略则 Escape 不关闭（由调用方决定）。 */
  onEscape?: () => void;
  /** 打开时自动聚焦首个可聚焦元素；默认 true。 */
  autoFocus?: boolean;
  /** 关闭后还原焦点到打开前的元素；默认 true。 */
  restoreFocus?: boolean;
}

export function useFocusTrap({
  containerRef,
  onEscape,
  autoFocus = true,
  restoreFocus = true,
}: FocusTrapOptions): void {
  // latest-ref：onEscape 通常是依赖组件 state（如 busy）的闭包，直接进 effect
  // 依赖会在每次 state 变化时重跑 effect——重新抢夺焦点并打乱 modal 栈顶次序。
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const id = pushModal();
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (autoFocus) {
      const target = container.querySelector<HTMLElement>("[data-autofocus]")
        ?? focusableIn(container)[0]
        ?? container;
      if (target === container && !container.hasAttribute("tabindex")) {
        container.setAttribute("tabindex", "-1");
      }
      target.focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // 嵌套时仅栈顶响应；外层挂起等内层关闭。
      if (!isTopModal(id)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableIn(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    // capture 阶段：先于 useKeyboardShortcuts 的 window 冒泡处理器，
    // 弹层内 Tab/Escape 不会外溢成背景三栏焦点切换。
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      popModal(id);
      if (restoreFocus && previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, autoFocus, restoreFocus]);
}
