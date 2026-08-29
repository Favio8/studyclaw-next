import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveMascotState,
  PULSE_WINDOW_MS,
  STREAM_HYSTERESIS_MS,
  useMascotState,
} from "../../src/components/mascot/useMascotState";
import { initialQuiz, useAppStore, type ChatMessage } from "../../src/store/useAppStore";

const T0 = 1_000_000;
const base = {
  hasError: false,
  pulseAt: null,
  quizPhase: "idle",
  streamPhase: null,
  streaming: false,
  chatFocus: false,
};

function agentMessage(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "agent", content: "", ...patch };
}

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
  vi.useRealTimers();
});

describe("deriveMascotState 优先级仲裁（§4.2）", () => {
  it("全空输入 → idle", () => {
    expect(deriveMascotState(base, T0)).toBe("idle");
  });

  it("优先级 1：会话错误 → alerting，且压过其它一切信号", () => {
    expect(deriveMascotState({ ...base, hasError: true }, T0)).toBe("alerting");
    expect(
      deriveMascotState(
        { ...base, hasError: true, pulseAt: T0 - 10, streamPhase: "thinking", chatFocus: true },
        T0,
      ),
    ).toBe("alerting");
  });

  it("优先级 2：celebrate 脉冲在 2400ms 窗口内生效，压过 quiz/stream/focus", () => {
    expect(deriveMascotState({ ...base, pulseAt: T0 - 100 }, T0)).toBe("celebrate");
    expect(
      deriveMascotState(
        { ...base, pulseAt: T0 - 10, quizPhase: "evaluating", streamPhase: "thinking", chatFocus: true },
        T0,
      ),
    ).toBe("celebrate");
  });

  it("脉冲窗口边界：now-at < 2400 才 celebrate，恰好 2400 已过期", () => {
    expect(deriveMascotState({ ...base, pulseAt: T0 - (PULSE_WINDOW_MS - 1) }, T0)).toBe("celebrate");
    expect(deriveMascotState({ ...base, pulseAt: T0 - PULSE_WINDOW_MS }, T0)).toBe("idle");
  });

  it("优先级 3：quiz scanning/evaluating → thinking，其余 phase 不触发", () => {
    expect(deriveMascotState({ ...base, quizPhase: "scanning" }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, quizPhase: "evaluating" }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, quizPhase: "answering" }, T0)).toBe("idle");
    expect(deriveMascotState({ ...base, quizPhase: "done" }, T0)).toBe("idle");
  });

  it("优先级 4：streamPhase=thinking → thinking（无需 streaming 标志）", () => {
    expect(deriveMascotState({ ...base, streamPhase: "thinking" }, T0)).toBe("thinking");
  });

  it("优先级 5：writing 需要 streaming 且 streamPhase=writing 同时成立", () => {
    expect(deriveMascotState({ ...base, streaming: true, streamPhase: "writing" }, T0)).toBe("writing");
    // streaming=false 时 writing 相位不生效（防御残留状态）
    expect(deriveMascotState({ ...base, streaming: false, streamPhase: "writing" }, T0)).toBe("idle");
  });

  it("优先级 6：输入聚焦 → listening", () => {
    expect(deriveMascotState({ ...base, chatFocus: true }, T0)).toBe("listening");
  });

  it("综合排序：error > pulse > quiz > streamPhase > focus", () => {
    expect(deriveMascotState({ ...base, pulseAt: T0, quizPhase: "scanning", chatFocus: true }, T0)).toBe("celebrate");
    expect(deriveMascotState({ ...base, quizPhase: "scanning", streamPhase: "writing", streaming: true }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, streamPhase: "writing", streaming: true, chatFocus: true }, T0)).toBe("writing");
  });
});

describe("useMascotState（挂载层：迟滞 / 脉冲 / 消息错误）", () => {
  it("thinking↔writing 互切有 300ms 迟滞；其它切换即时生效", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotState());
    expect(result.current).toBe("idle");

    act(() => {
      useAppStore.setState({ streamPhase: "thinking" });
    });
    expect(result.current).toBe("thinking");

    // thinking → writing：迟滞期内维持旧状态
    act(() => {
      useAppStore.setState({ streaming: true, streamPhase: "writing" });
    });
    expect(result.current).toBe("thinking");
    act(() => {
      vi.advanceTimersByTime(STREAM_HYSTERESIS_MS + 10);
    });
    expect(result.current).toBe("writing");

    // 非迟滞对（writing → alerting）立即切换，不等 300ms
    act(() => {
      useAppStore.setState({ messages: [agentMessage({ error: "boom" })] });
    });
    expect(result.current).toBe("alerting");
  });

  it("celebrate 脉冲 2400ms 后自动回落，且答错/无脉冲不触发", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotState());
    expect(result.current).toBe("idle");

    act(() => {
      useAppStore.getState().setMascotPulse({ at: Date.now() });
    });
    expect(result.current).toBe("celebrate");

    act(() => {
      vi.advanceTimersByTime(PULSE_WINDOW_MS + 20);
    });
    expect(result.current).toBe("idle");
  });

  it("alerting 来自最后一条 agent 消息的 error；追加新消息后自然回落", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotState());

    act(() => {
      useAppStore.setState({ messages: [agentMessage({ id: "a1" })] });
    });
    expect(result.current).toBe("idle");

    act(() => {
      useAppStore.setState({
        messages: [agentMessage({ id: "a1" }), agentMessage({ id: "a2", error: "rate limit" })],
      });
    });
    expect(result.current).toBe("alerting");

    // 用户重试/新消息 → 新占位卡无 error → 回落
    act(() => {
      useAppStore.setState({
        messages: [agentMessage({ id: "a1" }), agentMessage({ id: "a2", error: "rate limit" }), agentMessage({ id: "a3" })],
      });
    });
    expect(result.current).toBe("idle");
  });
});
