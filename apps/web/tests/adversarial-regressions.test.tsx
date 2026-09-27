/**
 * 对抗性审查（第二轮）回归护栏。
 *
 * 第一轮以 it.fails 刻画的三个缺陷（UI-9 乱序覆盖 / UI-10 meta 清空模型
 * 座位 / UI-16 switch-course 自切换）已修复，全部翻转为正向断言。
 * UI-6（重试错位重发）与 UI-19（建议入口重复点击）一并在此补上回归用例。
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { restoreSessionMock, streamChatMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn(),
  streamChatMock: vi.fn(),
}));

vi.mock("../src/lib/chatStream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chatStream")>();
  return {
    ...actual,
    streamChat: streamChatMock,
    streamAgentAnswer: vi.fn(),
  };
});
vi.mock("../src/lib/api", () => ({
  api: {
    sessions: vi.fn(async () => ({ sessions: [] })),
    restoreSession: restoreSessionMock,
    resumeAgent: vi.fn(async () => ({})),
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
import { useSessionActions } from "../src/hooks/useSessionActions";
import { runCommand } from "../src/lib/commands";
import { initialQuiz, useAppStore } from "../src/store/useAppStore";

beforeEach(() => {
  useAppStore.setState({
    activeCourseId: "course-1",
    activeSessionId: null,
    activeSessionTitle: "",
    activeModel: null,
    messages: [],
    streaming: false,
    streamPhase: null,
    queuedMessages: [],
    quiz: { ...initialQuiz },
    sessions: [],
    courseSessions: {},
    pendingAsk: null,
    wakeupCard: null,
    suggestedEntry: null,
    modeBanner: null,
  });
  restoreSessionMock.mockReset();
  streamChatMock.mockReset();
});

describe("UI-9 会话管理：乱序恢复守卫", () => {
  it("快速连点两个会话：后点的会话必须胜出（乱序恢复不得覆盖用户选择）", async () => {
    // S1 慢（50ms）、S2 快（0ms）——模拟用户先点 S1 再立刻点 S2，
    // 两个 restore 并发在途，先发起的 S1 响应后到。
    restoreSessionMock.mockImplementation(async (_courseId: string, sessionId: string) => {
      const delay = sessionId === "s1" ? 50 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { sessionId, title: `会话 ${sessionId}`, mode: "socratic", restored: true, turns: [], suggestedEntry: null, wakeup: null, pendingAsk: null };
    });
    const { result } = renderHook(() => useSessionActions());
    await act(async () => {
      const first = result.current.selectSession("s1", "course-1");
      const second = result.current.selectSession("s2", "course-1");
      await Promise.all([first, second]);
    });
    await waitFor(() => {
      expect(useAppStore.getState().activeSessionId).toBe("s2");
    });
  });
});

describe("UI-10 模型座位：meta 帧自动建会话", () => {
  it("首条消息 meta 帧：自动建会话不得清空刚设置的模型座位", async () => {
    // 服务端一帧同时带 sessionId（自动新建）与 model——真实 meta 帧形状。
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-new", model: "gpt-x", provider: "openai" } };
      yield { event: "token", data: { delta: "回答" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("第一条消息");
    });
    expect(useAppStore.getState().activeModel).toEqual({ providerId: "openai", model: "gpt-x" });
  });
});

describe("UI-16 课程切换：/switch-course", () => {
  it("唯一课程下自切换：直接反馈而不清空中栏视图", async () => {
    useAppStore.setState({
      courses: [{ id: "course-1", title: "课程一" } as never],
      messages: [{ id: "m1", role: "user", content: "历史消息" }],
    });
    const result = await runCommand("switch-course");
    expect(result.handled).toBe(true);
    expect(result.feedback).toContain("已是最后一个项目");
    // 视图未被重置。
    expect(useAppStore.getState().messages).toHaveLength(1);
    expect(useAppStore.getState().activeCourseId).toBe("course-1");
  });

  it("多课程时切换到下一门课程", async () => {
    useAppStore.setState({
      courses: [
        { id: "course-1", title: "课程一" },
        { id: "course-2", title: "课程二" },
      ] as never,
    });
    const result = await runCommand("switch-course");
    expect(result.handled).toBe(true);
    expect(result.feedback).toContain("课程二");
    expect(useAppStore.getState().activeCourseId).toBe("course-2");
  });
});

describe("UI-6 重试：按消息卡内容重发", () => {
  // mock 按 send 调用序号区分轮次（不能假设"每次 send 只调用一次 streamChat"）：
  // useChatStream.send 对非 abort 异常内部重试 MAX_ATTEMPTS=3 次，每轮都会
  // 重新调用 streamChat——旧实现 call===1 抛错、call===2 成功，消息一在第 2
  // 次内部重试即成功，失败卡从未产生，声明的重试路径实际未被覆盖（假绿）。

  it("网络耗尽产生失败卡后重试：复用失败回合的 requestId", async () => {
    let call = 0;
    streamChatMock.mockImplementation(async function* () {
      call += 1;
      if (call <= 3) {
        // 消息一：3 次尝试全部网络中断（MAX_ATTEMPTS=3）→ 失败卡 + lastFailure。
        yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
        throw new TypeError("failed to fetch");
      }
      // 重试：正常完成。
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "token", data: { delta: "一号重发" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("消息一");
    });
    // 消息一的 3 次尝试共享同一幂等键。
    const requestIds = streamChatMock.mock.calls.slice(0, 3).map((c) => (c[0] as { requestId: string }).requestId);
    expect(new Set(requestIds).size).toBe(1);
    // 模拟用户点"消息一"失败卡上的重试（ChatArea 传入该卡对应的用户文本）。
    await act(async () => {
      await result.current.retryLast("消息一");
    });
    const lastCall = streamChatMock.mock.calls.at(-1)![0] as { message: string; requestId: string };
    expect(lastCall.message).toBe("消息一");
    expect(lastCall.requestId).toBe(requestIds[0]);
  });

  it("旧失败卡在成功发送之后重试：重发该卡文本、不复用旧 requestId", async () => {
    let call = 0;
    streamChatMock.mockImplementation(async function* () {
      call += 1;
      if (call <= 3) {
        // 消息一：网络中断耗尽重试。
        yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
        throw new TypeError("failed to fetch");
      }
      // 消息二（call=4）：正常完成——成功会清空 lastFailure。
      if (call === 4) {
        yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
        yield { event: "token", data: { delta: "二号回复" } };
        yield { event: "done", data: { usage: {} } };
      }
      // 重试（call=5）：正常完成。
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "token", data: { delta: "一号重发" } };
      yield { event: "done", data: { usage: {} } };
    });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("消息一");
    });
    await act(async () => {
      await result.current.send("消息二");
    });
    const firstRequestId = (streamChatMock.mock.calls[0]![0] as { requestId: string }).requestId;
    await act(async () => {
      await result.current.retryLast("消息一");
    });
    const lastCall = streamChatMock.mock.calls.at(-1)![0] as { message: string; requestId: string };
    // 重发的是该卡自己的文本而不是"最后一次发送"（消息二）。
    expect(lastCall.message).toBe("消息一");
    // 成功发送已清空 lastFailure：不得复用消息一的旧 requestId。
    expect(lastCall.requestId).not.toBe(firstRequestId);
  });
});

describe("UI-19 建议入口：一次有效", () => {
  it("发送后 suggestedEntry 被清除，无法重复触发同文本轮次", async () => {
    streamChatMock.mockImplementation(async function* () {
      yield { event: "meta", data: { sessionId: "s-1", model: "m", provider: "p" } };
      yield { event: "token", data: { delta: "回复" } };
      yield { event: "done", data: { usage: {} } };
    });
    useAppStore.setState({ suggestedEntry: "继续上次的学习" });
    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("继续上次的学习");
    });
    expect(useAppStore.getState().suggestedEntry).toBeNull();
  });
});

describe("A1 answer 幂等键：绑定 (question, answer) 二元组", () => {
  async function answerOnce(result: { current: { answer: (text: string) => Promise<boolean> } }, text: string, mode: "ok" | "fail") {
    const { streamAgentAnswer } = await import("../src/lib/chatStream");
    (streamAgentAnswer as ReturnType<typeof vi.fn>).mockImplementation(async function* (_agentId: string, _answer: string, _signal?: AbortSignal, _requestId?: string) {
      if (mode === "fail") throw new TypeError("failed to fetch");
      yield { event: "meta", data: { sessionId: "s-1" } };
      yield { event: "token", data: { delta: "回复" } };
      yield { event: "done", data: {} };
    });
    await act(async () => {
      await result.current.answer(text);
    });
  }

  it("失败后同问题同答案重试：复用同一 requestId（服务端 attach 重放）", async () => {
    useAppStore.setState({ activeSessionId: "s-1", pendingAsk: { question: "什么是幂等？" } });
    const { result } = renderHook(() => useChatStream());
    const { streamAgentAnswer } = await import("../src/lib/chatStream");
    (streamAgentAnswer as ReturnType<typeof vi.fn>).mockClear();

    await answerOnce(result, "答案一", "fail");
    await answerOnce(result, "答案一", "ok");
    const calls = (streamAgentAnswer as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1]![3]).toBe(calls[0]![3]);
  });

  it("失败后修改答案再提交：requestId 必须变化（不得静默重放旧答案）", async () => {
    useAppStore.setState({ activeSessionId: "s-1", pendingAsk: { question: "什么是幂等？" } });
    const { result } = renderHook(() => useChatStream());
    const { streamAgentAnswer } = await import("../src/lib/chatStream");
    (streamAgentAnswer as ReturnType<typeof vi.fn>).mockClear();

    await answerOnce(result, "答案一", "fail");
    await answerOnce(result, "答案二", "ok");
    const calls = (streamAgentAnswer as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1]![3]).not.toBe(calls[0]![3]);
    // 第二次请求携带的答案文本是新答案
    expect(calls[1]![1]).toBe("答案二");
  });
});
