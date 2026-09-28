import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 右栏折叠的集成面：Console 必须把 store 旗标真正接进 grid（第三列归零）、
 * 右栏 section display:none、并给出浮动展开钮。旗标只改 store 而忘记接 grid
 * 是最可能的回归，因此这里断言 grid 实际内联样式。
 *
 * 用**真实 store**（只 mock 子组件与 api）：Zustand 的 set 会通知订阅并重渲染，
 * 自己造的 store mock 没有订阅机制，状态变更不反映到 DOM。
 */

vi.mock("../src/hooks/usePanelData", () => ({ usePanelData: () => {} }));
vi.mock("../src/hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => {} }));
vi.mock("../src/components/chat/ChatArea", () => ({ default: () => <div>chat</div> }));
vi.mock("../src/components/left/LeftNav", () => ({ default: () => <div>leftnav</div> }));
vi.mock("../src/components/panel/RightPanel", () => ({
  default: () => (
    <div data-testid="right-panel">
      <button type="button" onClick={() => useAppStore.getState().setRightPanelCollapsed(true)}>折叠右栏</button>
    </div>
  ),
}));
vi.mock("../src/components/palette/CommandPalette", () => ({ default: () => null }));
vi.mock("../src/components/settings/SettingsDialog", () => ({ default: () => null }));
vi.mock("../src/lib/api", () => ({
  api: {
    health: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({ ui: { defaultMode: "socratic" }, providers: [] })),
    workspaces: vi.fn(async () => ({ current: null, items: [] })),
    courseList: vi.fn(async () => ({ courses: [], missing: false })),
    ensureCourse: vi.fn(async () => ({})),
  },
}));

import Console from "../src/components/Console";
import { useAppStore } from "../src/store/useAppStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.getState().setRightPanelCollapsed(false);
});

/** grid 根元素（唯一带 gridTemplateColumns 内联样式的节点）。 */
function gridRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[style*="grid-template-columns"]');
}

/** 第三列（右栏）宽度——grid 中间是 minmax(0, 1fr) 自带空格，不能按空格切，
 *  取末尾的像素值。 */
function detailsColumn(): string {
  const value = (gridRoot()?.style.gridTemplateColumns ?? "").trim();
  const match = /(\d+)px$/.exec(value);
  return match ? `${match[1]}px` : "";
}

describe("Console 右栏折叠", () => {
  it("展开态：grid 第三列是右栏宽度，且没有浮动展开钮", () => {
    render(<Console />);
    expect(detailsColumn()).toBe("360px"); // DETAILS_DEFAULT
    expect(screen.queryByRole("button", { name: "展开右栏" })).toBeNull();
  });

  it("点右栏头部折叠钮 → grid 第三列归零、右栏 section 隐藏、出现浮动展开钮", () => {
    render(<Console />);
    fireEvent.click(screen.getByRole("button", { name: "折叠右栏" }));

    expect(detailsColumn()).toBe("0px");
    // 右栏 section 被 display:none（hidden 类）而不是卸载。
    const section = screen.getByTestId("right-panel").closest("section");
    expect(section).not.toBeNull();
    expect(section).toHaveClass("hidden");
    // 右栏拖拽把手同时隐藏。
    expect(screen.getByRole("separator", { name: "调整右栏宽度" })).toHaveClass("hidden");
    // 浮动展开钮出现。
    expect(screen.getByRole("button", { name: "展开右栏" })).toHaveAttribute("title", "展开右栏（Ctrl+B）");
  });

  it("点浮动展开钮 → 恢复原宽度（detailsWidth 未被折叠清掉）", () => {
    useAppStore.getState().setRightPanelCollapsed(true);
    render(<Console />);
    expect(detailsColumn()).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "展开右栏" }));
    expect(useAppStore.getState().rightPanelCollapsed).toBe(false);
    expect(detailsColumn()).toBe("360px");
    expect(screen.queryByRole("button", { name: "展开右栏" })).toBeNull();
  });
});
