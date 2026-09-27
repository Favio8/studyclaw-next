/**
 * FE-1 回归：业务 error 帧是终态——消息卡进入错误态的同时，全局流式态
 * 必须收尾（streaming=false、streamPhase 清空）。此前 send 循环的 FE-1
 * 早退路径漏了 setStreaming(false)，shimmer 行和输入框会永久卡在"生成中"。
 *
 * A4 队列状态机回归：除 abort 外的每个终态都推进队列（成功/业务 error/
 * 重试耗尽），abort 永不推进。
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

describe("useChatStream A4 队列终态语义", () => {
  it("业务 error 帧后排队消息照常发出（drain 不只走成功路径）", async () => {
    // 旧实现只在成功路径 drain：用户连发三条、第一条撞上业务 error，
    // 后两条永久卡在队列里（streaming 已 false，没有任何提示）。
    const seen: string[] = [];
    streamChatMock.mockImplementation(async function* (input: { message: string }) {
      seen.push(input.message);
      if (seen.length === 1) {
        yield { event: "meta", data: { sessionId: "s-err", model: "mock-model", provider: "mock" } };
        yield { event: "error", data: { code: "E_TEST", message: "boom" } };
        return;
      }
      yield { event: "meta", data: { sessionId: "s-err", model: "mock-model", provider: "mock" } };
      yield { event: "token", data: { delta: "第二条的回答" } };
      yield { event: "done", data: { usage: {} } };
    });
    useAppStore.setState({
      activeSessionId: "s-err",
      queuedMessages: [{ text: "排队第二条", turnId: "t_q1" }],
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("第一条");
    });
    expect(seen).toEqual(["第一条", "排队第二条"]);
    expect(useAppStore.getState().queuedMessages).toEqual([]);
  });

  it("网络重试耗尽后同样推进队列", async () => {
    // 非 abort 异常：重试到 MAX_ATTEMPTS 后 break 出循环——旧实现在这里
    // 也不 drain，排队消息同样卡死。
    let calls = 0;
    streamChatMock.mockImplementation(async function* (input: { message: string }) {
      calls += 1;
      if (input.message === "排队第二条") {
        yield { event: "meta", data: { sessionId: "s-net", model: "mock-model", provider: "mock" } };
        yield { event: "done", data: { usage: {} } };
        return;
      }
      throw new Error("network down");
    });
    useAppStore.setState({
      activeSessionId: "s-net",
      queuedMessages: [{ text: "排队第二条" }],
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("第一条");
    });
    // 第一条重试 3 次（MAX_ATTEMPTS）全部失败 → 终态 drain → 第二条发出并成功。
    expect(calls).toBe(4);
    expect(useAppStore.getState().queuedMessages).toEqual([]);
  });

  it("abort 后不推进队列（旧会话排队文本不得进新会话）", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-old", model: "mock-model", provider: "mock" } };
      const error = new DOMException("aborted", "AbortError");
      throw error;
    });
    useAppStore.setState({
      activeSessionId: "s-old",
      queuedMessages: [{ text: "排队第二条", turnId: "t_q1" }],
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("第一条");
    });
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    // 队列原样保留（归属未变，clearStaleQueue 不清；drain 不走 abort 路径）。
    expect(useAppStore.getState().queuedMessages).toEqual([{ text: "排队第二条", turnId: "t_q1" }]);
  });
});
