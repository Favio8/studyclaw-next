import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => {
  const state = {
    mode: "socratic" as const,
    pendingAsk: null,
    activeCourseId: "course-a",
    activeSessionId: "session-a" as string | null,
    workspacePath: "D:/learn/ws-a" as string | null,
    composerDrafts: {} as Record<string, string>,
    setMode: vi.fn(),
    flashModeBanner: vi.fn(),
    setPaletteOpen: vi.fn(),
    setComposerDraft: vi.fn((key: string, draft: string) => {
      const next = { ...state.composerDrafts };
      if (draft === "") delete next[key];
      else next[key] = draft;
      state.composerDrafts = next;
    }),
  };
  return {
    storeState: state,
    apiMocks: { courseFiles: vi.fn() },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
vi.mock("../src/components/chat/ModelSeat", () => ({ default: () => null }));

import ChatInput from "../src/components/chat/ChatInput";

apiMocks.courseFiles.mockResolvedValue({ files: [] });

function draftKey(): string {
  return `${storeState.workspacePath ?? ""}\0${storeState.activeCourseId ?? ""}\0${storeState.activeSessionId ?? "new"}`;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.mode = "socratic";
  storeState.pendingAsk = null;
  storeState.activeCourseId = "course-a";
  storeState.activeSessionId = "session-a";
  storeState.workspacePath = "D:/learn/ws-a";
  storeState.composerDrafts = {};
  apiMocks.courseFiles.mockResolvedValue({ files: [] });
});

describe("ChatInput session drafts", () => {
  it("对齐 dsh：草稿按工作区、课程与会话隔离，切回后恢复", () => {
    const { rerender } = render(<ChatInput onSend={vi.fn()} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "会话 A 的草稿" } });
    expect(storeState.setComposerDraft).toHaveBeenCalledWith(draftKey(), "会话 A 的草稿");
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("会话 A 的草稿");

    storeState.activeSessionId = "session-b";
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "会话 B 的草稿" } });
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("会话 B 的草稿");

    storeState.activeSessionId = "session-a";
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("会话 A 的草稿");

    storeState.activeCourseId = "course-b";
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("");

    storeState.activeCourseId = "course-a";
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("会话 A 的草稿");

    storeState.workspacePath = "D:/learn/ws-b";
    rerender(<ChatInput onSend={vi.fn()} />);
    expect(input).toHaveValue("");
  });

  it("发送后只清除当前会话草稿", () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "发送这条消息" } });
    rerender(<ChatInput onSend={onSend} />);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("发送这条消息");
    expect(storeState.setComposerDraft).toHaveBeenLastCalledWith(draftKey(), "");

    rerender(<ChatInput onSend={onSend} />);
    expect(input).toHaveValue("");
  });

  it("对齐 dsh：按住 Enter 不会重复发送同一草稿", () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "不能重复发送" } });
    rerender(<ChatInput onSend={onSend} />);

    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    expect(onSend).not.toHaveBeenCalled();

    rerender(<ChatInput onSend={onSend} />);
    expect(input).toHaveValue("不能重复发送");
  });

  it("只允许从当前课程资料 rail 添加安全 fileRef，并支持移除", async () => {
    apiMocks.courseFiles.mockResolvedValue({ files: [{ relative: "sources/intro.md", size: 120, supported: true }] });
    render(<ChatInput onSend={vi.fn()} />);
    await waitFor(() => expect(apiMocks.courseFiles).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "添加课程资料" }));
    fireEvent.mouseDown(await screen.findByRole("option", { name: /sources\/intro\.md/ }));
    expect(storeState.setComposerDraft).toHaveBeenLastCalledWith(draftKey(), "@sources/intro.md ");
    expect(screen.getByLabelText("已附加课程资料")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除附件 sources/intro.md" }));
    expect(storeState.setComposerDraft).toHaveBeenLastCalledWith(draftKey(), "");
  });
});
