import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveMascotState,
  ENCOURAGE_WINDOW_MS,
  PULSE_WINDOW_MS,
  STREAM_HYSTERESIS_MS,
  useMascotState,
} from "../../src/components/mascot/useMascotState";
import { poseTargets } from "../../src/components/mascot/tables";
import { initialQuiz, useAppStore, type ChatMessage } from "../../src/store/useAppStore";

const T0 = 1_000_000;
const base = {
  hasError: false,
  pulse: null,
  quizPhase: "idle",
  streamPhase: null,
  streaming: false,
  chatFocus: false,
  toolRunning: 0,
  uploading: false,
  buildRunning: false,
  syncing: false,
  asking: false,
};

function agentMessage(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "agent", content: "", ...patch };
}

beforeEach(() => {
  useAppStore.setState({
    streamPhase: null,
    toolRunning: 0,
    uploading: false,
    chatFocus: false,
    mascotPulse: null,
    streaming: false,
    syncState: "synced",
    buildStatus: "idle",
    messages: [],
    pendingAsk: null,
    quiz: { ...initialQuiz },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deriveMascotState 优先级仲裁（§4.2 + §7.2 P1 扩展）", () => {
  it("全空输入 → idle", () => {
    expect(deriveMascotState(base, T0)).toBe("idle");
  });

  it("优先级 1：会话错误 → alerting，且压过其它一切信号", () => {
    expect(deriveMascotState({ ...base, hasError: true }, T0)).toBe("alerting");
    expect(
      deriveMascotState(
        { ...base, hasError: true, pulse: { at: T0 - 10, kind: "celebrate" }, streamPhase: "thinking", chatFocus: true },
        T0,
      ),
    ).toBe("alerting");
  });

  it("优先级 2/3：celebrate 压过 encourage；各自窗口内生效", () => {
    expect(deriveMascotState({ ...base, pulse: { at: T0 - 100, kind: "celebrate" } }, T0)).toBe("celebrate");
    expect(deriveMascotState({ ...base, pulse: { at: T0 - 100, kind: "encourage" } }, T0)).toBe("encourage");
    expect(
      deriveMascotState(
        { ...base, pulse: { at: T0 - 10, kind: "encourage" }, quizPhase: "evaluating", streamPhase: "thinking", chatFocus: true },
        T0,
      ),
    ).toBe("encourage");
  });

  it("celebrate 窗口边界：now-at < 2400 才生效，恰好 2400 已过期", () => {
    const pulse = { at: T0 - (PULSE_WINDOW_MS - 1), kind: "celebrate" as const };
    expect(deriveMascotState({ ...base, pulse }, T0)).toBe("celebrate");
    expect(deriveMascotState({ ...base, pulse: { at: T0 - PULSE_WINDOW_MS, kind: "celebrate" } }, T0)).toBe("idle");
  });

  it("encourage 窗口边界：4000ms", () => {
    const pulse = { at: T0 - (ENCOURAGE_WINDOW_MS - 1), kind: "encourage" as const };
    expect(deriveMascotState({ ...base, pulse }, T0)).toBe("encourage");
    expect(deriveMascotState({ ...base, pulse: { at: T0 - ENCOURAGE_WINDOW_MS, kind: "encourage" } }, T0)).toBe("idle");
  });

  it("优先级 4：quiz scanning/evaluating → thinking，其余 phase 不触发", () => {
    expect(deriveMascotState({ ...base, quizPhase: "scanning" }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, quizPhase: "evaluating" }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, quizPhase: "answering" }, T0)).toBe("idle");
  });

  it("优先级 5：Agent 提问等待 → asking，压过流式相位", () => {
    expect(deriveMascotState({ ...base, asking: true }, T0)).toBe("asking");
    expect(deriveMascotState({ ...base, asking: true, streamPhase: "thinking" }, T0)).toBe("asking");
  });

  it("优先级 6：streamPhase=thinking → thinking（无需 streaming 标志）", () => {
    expect(deriveMascotState({ ...base, streamPhase: "thinking" }, T0)).toBe("thinking");
  });

  it("优先级 7：执行中工具 → searching，压过 writing", () => {
    expect(deriveMascotState({ ...base, toolRunning: 1 }, T0)).toBe("searching");
    expect(
      deriveMascotState({ ...base, streaming: true, streamPhase: "writing", toolRunning: 2 }, T0),
    ).toBe("searching");
  });

  it("优先级 8：writing 需要 streaming 且 streamPhase=writing 同时成立", () => {
    expect(deriveMascotState({ ...base, streaming: true, streamPhase: "writing" }, T0)).toBe("writing");
    expect(deriveMascotState({ ...base, streaming: false, streamPhase: "writing" }, T0)).toBe("idle");
  });

  it("优先级 9-11：uploading > working > progress", () => {
    expect(deriveMascotState({ ...base, uploading: true }, T0)).toBe("uploading");
    expect(deriveMascotState({ ...base, buildRunning: true }, T0)).toBe("working");
    expect(deriveMascotState({ ...base, syncing: true }, T0)).toBe("progress");
    expect(deriveMascotState({ ...base, uploading: true, buildRunning: true, syncing: true }, T0)).toBe("uploading");
    expect(deriveMascotState({ ...base, buildRunning: true, syncing: true }, T0)).toBe("working");
  });

  it("优先级 12：输入聚焦 → listening", () => {
    expect(deriveMascotState({ ...base, chatFocus: true }, T0)).toBe("listening");
  });

  it("综合排序：error > pulse > asking > streamPhase > tool > writing > uploading", () => {
    expect(deriveMascotState({ ...base, pulse: { at: T0, kind: "celebrate" }, asking: true, chatFocus: true }, T0)).toBe("celebrate");
    expect(deriveMascotState({ ...base, asking: true, streamPhase: "writing", streaming: true }, T0)).toBe("asking");
    expect(deriveMascotState({ ...base, quizPhase: "scanning", streamPhase: "writing", streaming: true }, T0)).toBe("thinking");
    expect(deriveMascotState({ ...base, streamPhase: "writing", streaming: true, uploading: true, chatFocus: true }, T0)).toBe("writing");
  });
});

describe("六态 pose 关键数值锁定（tables.ts，评审数值）", () => {
  it("celebrate 举爪 -14（PR-2 微调：原型 -26 盖嘴线，评审 P2 修复）", () => {
    const pose = poseTargets("celebrate", 10, 1);
    expect(pose.pawL).toBe(-14);
    expect(pose.pawR).toBe(-14);
    expect(pose.mouth).toBe(1.6);
    expect(pose.lid).toBe(1);
  });

  it("静态相位（ph=0, dtS=0）下全部十四态均为有限值标准姿态（reduced-motion 依据）", () => {
    for (const state of [
      "idle",
      "listening",
      "thinking",
      "writing",
      "celebrate",
      "alerting",
      "sleeping",
      "waking",
      "searching",
      "working",
      "uploading",
      "asking",
      "encourage",
      "progress",
    ] as const) {
      const pose = poseTargets(state, 0, 0);
      for (const value of Object.values(pose)) {
        expect(Number.isFinite(value), state).toBe(true);
      }
    }
    expect(poseTargets("thinking", 0, 0).headT).toBe(6);
    expect(poseTargets("idle", 0, 0).bob).toBe(0);
    // sleeping：闭眼横线（引擎据 P.lid 压下眼睑）
    expect(poseTargets("sleeping", 0, 0).lid).toBe(0.06);
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

  it("celebrate 脉冲 2400ms 后自动回落", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotState());
    expect(result.current).toBe("idle");

    act(() => {
      useAppStore.getState().setMascotPulse({ at: Date.now(), kind: "celebrate" });
    });
    expect(result.current).toBe("celebrate");

    act(() => {
      vi.advanceTimersByTime(PULSE_WINDOW_MS + 20);
    });
    expect(result.current).toBe("idle");
  });

  it("encourage 脉冲 4000ms 后自动回落（答错路径）", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotState());

    act(() => {
      useAppStore.getState().setMascotPulse({ at: Date.now(), kind: "encourage" });
    });
    expect(result.current).toBe("encourage");

    act(() => {
      vi.advanceTimersByTime(ENCOURAGE_WINDOW_MS + 20);
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
