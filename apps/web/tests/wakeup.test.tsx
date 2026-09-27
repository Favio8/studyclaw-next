/**
 * W-1 回归：唤醒卡作答必须与 quizFlow 同口径——透传 sessionId / AbortSignal /
 * evalId（内容指纹）。旧实现三参全不传：SSE 中断后重试被服务端当新匿名 eval
 * 再次 settle（SM-2/进度重复计分），且在途流不可中止。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    activeCourseId: "course-1",
    activeSessionId: "session-1",
    setMascotPulse: vi.fn(),
  },
  apiMocks: {
    evalSubmit: vi.fn(),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
vi.mock("../src/lib/panelData", () => ({
  refreshCourseList: vi.fn(() => Promise.resolve()),
  refreshPanelData: vi.fn(() => Promise.resolve()),
}));

import { abortActiveWakeupEval, submitWakeupAnswer } from "../src/lib/wakeup";

beforeEach(() => {
  apiMocks.evalSubmit.mockClear();
});

function settledStream(): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  return (async function* () {
    yield { event: "result", data: { passed: true, score: 1, feedback: "答得好", misconceptions: [] } };
    yield { event: "sm2", data: { nextReviewAt: "2026-10-01", masteryDelta: 0.2 } };
  })();
}

describe("唤醒卡评测幂等与中止（W-1）", () => {
  it("透传 sessionId / signal / evalId，并返回判定结果", async () => {
    apiMocks.evalSubmit.mockReturnValue(settledStream());
    const result = await submitWakeupAnswer("course-1", "task-1", "我的答案");
    expect(apiMocks.evalSubmit).toHaveBeenCalledTimes(1);
    const [courseId, taskId, answer, sessionId, signal, evalId] = apiMocks.evalSubmit.mock.calls[0]!;
    expect(courseId).toBe("course-1");
    expect(taskId).toBe("task-1");
    expect(answer).toBe("我的答案");
    expect(sessionId).toBe("session-1");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(evalId).toContain("ev_course-1_task-1_session-1");
    expect(result).toMatchObject({ passed: true, score: 1, nextReviewAt: "2026-10-01", masteryDelta: 0.2 });
  });

  it("同一作答的 evalId 稳定（重试命中服务端幂等账本）；答案变化生成新键", async () => {
    apiMocks.evalSubmit.mockReturnValue(settledStream());
    await submitWakeupAnswer("course-1", "task-1", "same");
    await submitWakeupAnswer("course-1", "task-1", "same");
    const first = apiMocks.evalSubmit.mock.calls[0]![5];
    const second = apiMocks.evalSubmit.mock.calls[1]![5];
    expect(first).toBe(second);
    await submitWakeupAnswer("course-1", "task-1", "other");
    expect(apiMocks.evalSubmit.mock.calls[2]![5]).not.toBe(first);
  });

  it("abortActiveWakeupEval 中止在途流（signal 已 abort，Promise 以拒绝收尾）", async () => {
    let seen: AbortSignal | undefined;
    apiMocks.evalSubmit.mockImplementation((...args: unknown[]) => {
      seen = args[4] as AbortSignal;
      return (async function* () {
        await new Promise<void>((_resolve, reject) => {
          seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        })
      })()
    });
    const pending = submitWakeupAnswer("course-1", "task-1", "x");
    abortActiveWakeupEval();
    await expect(pending).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });
});
