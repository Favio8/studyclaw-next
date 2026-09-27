/**
 * FE-1 回归：业务 error 帧是终态——消息卡进入错误态的同时，全局流式态
 * 必须收尾（streaming=false、streamPhase 清空）。此前 send 循环的 FE-1
 * 早退路径漏了 setStreaming(false)，shimmer 行和输入框会永久卡在"生成中"。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
}));

vi.mock("../src/lib/chatStream", () => ({
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  registerActiveChat: vi.fn(),
  unregisterActiveChat: vi.fn(),
  abortActiveChat: vi.fn(),
  streamAgentAnswer: vi.fn(),
  streamChat: streamChatMock,
}));
vi.mock("../src/lib/api", () => ({
  api: {
    sessions: vi.fn(async () => ({ sessions: [] })),
    enqueueAgent: vi.fn(async () => ({ turnId: "t_x" })),
  },
}));
vi.mock("../src/hooks/usePanelData", () => ({
  usePanelData: () => ({ refresh: vi.fn(async () => {}) }),
}));
vi.mock("../src/lib/panelData", () => ({
  notifyPanelChanged: vi.fn(),
  refreshCourseList: vi.fn(async () => {}),
}));

import { useChatStream } from "../src/hooks/useChatStream";
import { initialQuiz, useAppStore } from "../src/store/useAppStore";

beforeEach(() => {
  useAppStore.setState({
    activeCourseId: "course-1",
    activeSessionId: null,
    activeSessionTitle: "",
    messages: [],
    streaming: false,
    streamPhase: null,
    queuedMessages: [],
    quiz: { ...initialQuiz },
  });
  streamChatMock.mockReset();
});

describe("useChatStream FE-1 终态收尾", () => {
  it("业务 error 帧后 streaming=false、streamPhase 清空、消息卡带错误", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-err", model: "mock-model", provider: "mock" } };
      yield { event: "thinking", data: { delta: "想一想" } };
      yield { event: "error", data: { code: "E_TEST", message: "boom" } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("触发服务端错误");
    });
    const state = useAppStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamPhase).toBeNull();
    const lastAgent = [...state.messages].reverse().find((m) => m.role === "agent");
    expect(lastAgent?.error).toContain("E_TEST");
    expect(lastAgent?.streaming).toBe(false);
  });

  it("正常 done 帧同样收尾（对照路径不受影响）", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-ok", model: "mock-model", provider: "mock" } };
      yield { event: "token", data: { delta: "回答正文" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("正常一轮");
    });
    const state = useAppStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamPhase).toBeNull();
    const lastAgent = [...state.messages].reverse().find((m) => m.role === "agent");
    expect(lastAgent?.content).toContain("回答正文");
    expect(lastAgent?.error).toBeUndefined();
  });
});
