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
    composerReferences: {} as Record<string, { source: string; page: number; quote: string; result?: string; kind?: "translate" | "explain" }>,
    setComposerReference: vi.fn((key: string, reference: typeof state.composerReferences[string] | null) => {
      if (reference === null) delete state.composerReferences[key];
      else state.composerReferences[key] = reference;
    }),
    setMode: vi.fn(),
    flashModeBanner: vi.fn(),
    setPaletteOpen: vi.fn(),
    // 爪爪 listening 输入源（PR-1 新增字段）：测试内不关心调用
    setChatFocus: vi.fn(),
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
  storeState.composerReferences = {};
  apiMocks.courseFiles.mockResolvedValue({ files: [] });
});

describe("ChatInput session drafts", () => {
  it("阅读引用可见、按会话隔离，并完整进入发送的消息", () => {
    const key = draftKey();
    const quote = "原文内容".repeat(400);
    const result = "完整译文".repeat(400);
    storeState.composerReferences[key] = { source: "paper.pdf", page: 3, quote, result, kind: "translate" };
    storeState.composerDrafts[key] = "请解释这里";
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} />);
    expect(screen.getByTestId("composer-reference")).toHaveTextContent("第 3 页");
    storeState.activeSessionId = "another-session";
    rerender(<ChatInput onSend={onSend} />);
    expect(screen.queryByTestId("composer-reference")).toBeNull();
    storeState.activeSessionId = "session-a";
    rerender(<ChatInput onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(`请解释这里\n\n引用资料：paper.pdf · 第 3 页\n原文：\n${quote}\n\n译文：\n${result}`);
    expect(storeState.composerReferences[key]).toBeUndefined();
  });
  it("移除引用后只发送用户自己的问题", () => {
    storeState.composerReferences[draftKey()] = { source: "paper.pdf", page: 1, quote: "引用" };
    storeState.composerDrafts[draftKey()] = "问题";
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "移除引用" }));
    rerender(<ChatInput onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("问题");
  });
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

describe("ChatInput 模式控件已上移到活动栏", () => {
  it("输入框不再承载模式切换（窄行 CJK 折字问题；控件在 CenterSwitcher 独占行）", () => {
    render(<ChatInput onSend={vi.fn()} />);
    // 旧实现在 composer footer 用单控件下拉，四按钮分段会按字折断成两行；
    // 现在对话风格是中栏活动栏右置的分段控件（center-switcher.test.tsx 覆盖），
    // 这里只做回归守卫：输入框内不得再出现模式菜单。
    expect(screen.queryByRole("button", { name: "苏格拉底" })).toBeNull();
    expect(screen.queryByRole("menu", { name: "切换学习模式" })).toBeNull();
    expect(document.querySelector("[data-mode-menu]")).toBeNull();
  });
});
