import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Clawzy, resolveTier } from "../../src/components/mascot";
import { tickSubscriberCount } from "../../src/components/mascot/ticker";
import { initialQuiz, useAppStore } from "../../src/store/useAppStore";

/** 下一帧（jsdom pretendToBeVisual 提供 rAF）。 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** mouthPhil / earIn（内耳）path 的开头，用于 tier 裁剪断言。 */
const MOUTH_D = "M120 112.4";
const EAR_IN_D = "M50.5 22.5";

beforeEach(() => {
  useAppStore.setState({
    streamPhase: null,
    chatFocus: false,
    mascotPulse: null,
    streaming: false,
    messages: [],
    quiz: { ...initialQuiz },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Clawzy 渲染契约", () => {
  it("渲染 svg role=img + aria-label（自动派生默认 idle）", () => {
    render(<Clawzy size={64} />);
    expect(screen.getByRole("img", { name: "爪爪：idle" })).toBeInTheDocument();
  });

  it("受控 state 生效（aria-label 与 data-mascot-state）", () => {
    render(<Clawzy size={64} state="thinking" />);
    const svg = screen.getByRole("img", { name: "爪爪：thinking" });
    expect(svg).toHaveAttribute("data-mascot-state", "thinking");
  });

  it("ariaLabel 可自定义", () => {
    render(<Clawzy size={20} state="idle" ariaLabel="会话助手" />);
    expect(screen.getByRole("img", { name: "会话助手" })).toBeInTheDocument();
  });

  it("icon 档裁剪：无嘴线、无内耳三角、无眼高光", () => {
    const { container } = render(<Clawzy size={20} />);
    expect(container.querySelector(`path[d^="${MOUTH_D}"]`)).toBeNull();
    expect(container.querySelector(`path[d^="${EAR_IN_D}"]`)).toBeNull();
    expect(container.querySelector('circle[r="3.7"]')).toBeNull();
  });

  it("full 档完整：嘴线、内耳三角、眼高光齐全", () => {
    const { container } = render(<Clawzy size={64} />);
    expect(container.querySelector(`path[d^="${MOUTH_D}"]`)).not.toBeNull();
    expect(container.querySelector(`path[d^="${EAR_IN_D}"]`)).not.toBeNull();
    expect(container.querySelector('circle[r="3.7"]')).not.toBeNull();
  });

  it("tier 缺省规则：<48 icon、≥48 full；显式传入优先", () => {
    expect(resolveTier(14)).toBe("icon");
    expect(resolveTier(32)).toBe("icon");
    expect(resolveTier(47)).toBe("icon");
    expect(resolveTier(48)).toBe("full");
    expect(resolveTier(96)).toBe("full");
    expect(resolveTier(96, "icon")).toBe("icon");
  });

  it("首帧输出确定（两次渲染 innerHTML 一致，SSR 水合安全）", () => {
    const first = render(<Clawzy size={24} />);
    const html = first.container.innerHTML;
    first.unmount();
    const second = render(<Clawzy size={24} />);
    expect(second.container.innerHTML).toBe(html);
  });
});

describe("Clawzy 引擎生命周期", () => {
  it("挂载订阅共享 ticker，卸载后订阅数归零", () => {
    const { unmount } = render(<Clawzy size={64} />);
    expect(tickSubscriberCount()).toBe(1);
    unmount();
    expect(tickSubscriberCount()).toBe(0);
  });

  it("reduced-motion：弹簧硬赋值到目标（两帧输出完全一致，thinking 歪头到位）", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const { container } = render(<Clawzy size={64} state="thinking" />);
    await nextFrame(); // 引擎首帧写入
    const root = container.querySelector("svg > g");
    if (root === null) throw new Error("root group missing");
    const first = root.getAttribute("transform");
    expect(first).not.toBeNull();
    await nextFrame();
    await nextFrame();
    expect(root.getAttribute("transform")).toBe(first);

    // thinking 静态姿态：头部歪到 +6°（硬赋值，非弹簧过渡中值）。
    // root 的直接子级 g 依次为 [tail, head, pawL, pawR]，head 取 index 1。
    const head = container.querySelectorAll("svg > g > g")[1];
    expect(head.getAttribute("transform")).toBe("rotate(6.00 120 118)");
  });

  it("正常模式：引擎逐帧写入 transform（值随时间变化）", async () => {
    const { container } = render(<Clawzy size={64} state="writing" />);
    await nextFrame();
    const root = container.querySelector("svg > g");
    if (root === null) throw new Error("root group missing");
    const first = root.getAttribute("transform");
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(root.getAttribute("transform")).not.toBe(first);
  });
});

describe("Clawzy 与 store 派生联动", () => {
  it("streamPhase 变化驱动自动档 aria-label 切换", async () => {
    render(<Clawzy size={64} />);
    expect(screen.getByRole("img", { name: "爪爪：idle" })).toBeInTheDocument();
    await act(async () => {
      useAppStore.setState({ streaming: true, streamPhase: "thinking" });
    });
    expect(screen.getByRole("img", { name: "爪爪：thinking" })).toBeInTheDocument();
  });
});
