import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 没有项目时的空态：旧实现只让用户"去左栏点添加项目"，而中栏这片唯一有
 *  注意力的地方却是死端（没有 composer、没有按钮）。现在直接把入口建在这里。 */

const { storeState, setWizardOpen } = vi.hoisted(() => {
  const setWizardOpen = vi.fn();
  return {
    setWizardOpen,
    storeState: {
      courses: [] as Array<{ id: string; title: string }>,
      activeCourseId: null as string | null,
      activeSessionId: null as string | null,
      activeSessionTitle: "",
      messages: [] as unknown[],
      streaming: false,
      sessionBanner: null as string | null,
      wakeupCard: null as unknown,
      suggestedEntry: null as string | null,
      modeBanner: null as string | null,
      flashStatusBanner: vi.fn(),
      setWizardOpen,
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
// ChatArea 的重依赖全部 mock 成空壳，只验空态引导段。
vi.mock("../src/hooks/useChatStream", () => ({ useChatStream: () => ({ send: vi.fn(), answer: vi.fn(), retryLast: vi.fn(), stop: vi.fn() }) }));
vi.mock("../src/hooks/useSessionActions", () => ({ useSessionActions: () => ({ forkSession: vi.fn() }) }));
vi.mock("../src/components/chat/ChatInput", () => ({ default: () => null }));
vi.mock("../src/components/chat/MessageCard", () => ({ default: () => null }));
vi.mock("../src/components/chat/ApprovalPanel", () => ({ default: () => null }));
vi.mock("../src/components/chat/QueueDock", () => ({ default: () => null }));
vi.mock("../src/components/chat/StatsLine", () => ({ default: () => null }));
vi.mock("../src/components/chat/WakeupCard", () => ({ default: () => null }));
vi.mock("../src/components/mascot/Clawzy", () => ({ default: () => null }));

import ChatArea from "../src/components/chat/ChatArea";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.activeCourseId = null;
});

describe("ChatArea 无项目空态", () => {
  it("直接给「添加项目」按钮，点击打开向导", () => {
    storeState.activeCourseId = null;
    render(<ChatArea />);

    expect(screen.getByText("还没有学习项目")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "添加项目" });
    fireEvent.click(button);
    expect(setWizardOpen).toHaveBeenCalledWith(true);
  });

  it("有项目时不再渲染该空态（进入正常三栏/hero）", () => {
    storeState.activeCourseId = "course-1";
    render(<ChatArea />);

    expect(screen.queryByText("还没有学习项目")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加项目" })).toBeNull();
    expect(screen.getByText("今天学点什么？")).toBeInTheDocument();
  });
});
