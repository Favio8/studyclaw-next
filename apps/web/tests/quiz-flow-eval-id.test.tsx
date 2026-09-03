/**
 * A2（第三轮审查）回归：评测幂等键只在失败重试时复用。
 *
 * - 同内容两次 quizAnswer（合法的重复练习）→ evalId 不同 → 服务端正常结算两次；
 * - quizRetry（失败重试）→ evalId 与上次相同 → 服务端重放已结算帧，不二次计分；
 * - quizNext/quizLoad 换题后 → 键重置。
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { evalSubmitMock } = vi.hoisted(() => ({ evalSubmitMock: vi.fn() }));

vi.mock("../src/lib/api", () => ({
  api: {
    evalSubmit: evalSubmitMock,
  },
}));
vi.mock("../src/lib/panelData", () => ({
  notifyPanelChanged: vi.fn(),
  refreshCourseList: vi.fn(async () => {}),
}));

import { quizAnswer, quizLoad, quizNext, quizRetry } from "../src/lib/quizFlow";
import { initialQuiz, useAppStore } from "../src/store/useAppStore";

const TASK = {
  taskId: "t_001",
  question: "1+1=?",
  difficulty: 1,
  options: null,
  answerIndex: null,
  answerRationale: null,
};

function mockEvalStream(): void {
  evalSubmitMock.mockImplementation(async function* () {
    yield { event: "result", data: { score: 1, passed: true, feedback: "对", misconceptions: [] } };
    yield { event: "sm2", data: { ef: 2.5, efNew: 2.6, nextReviewAt: "2026-09-04", masteryDelta: 0.1 } };
    yield { event: "done", data: { taskId: "t_001" } };
  });
}

async function flushQuizAnswer(text: string, opts?: { reuseEvalId?: string | null }): Promise<void> {
  await act(async () => {
    await quizAnswer(text, opts);
  });
  // quizAnswer 内部有 300ms 扫描线等待；act 已消化微任务，宏任务定时器
  // 由真实计时推进——这里额外等待确保流消费完毕。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

beforeEach(() => {
  useAppStore.setState({
    activeCourseId: "course-1",
    activeSessionId: "s-1",
    quiz: { ...initialQuiz, tasks: [TASK as never], index: 0, phase: "idle" },
  });
  evalSubmitMock.mockReset();
});

describe("A2 评测幂等键生命周期", () => {
  it("同内容两次正常作答：evalId 不同（合法重复练习必须各自结算）", async () => {
    mockEvalStream();
    const { rerender } = renderHook(() => useAppStore());
    void rerender;

    await flushQuizAnswer("2");
    await flushQuizAnswer("2");

    expect(evalSubmitMock).toHaveBeenCalledTimes(2);
    const firstEvalId = evalSubmitMock.mock.calls[0]![5];
    const secondEvalId = evalSubmitMock.mock.calls[1]![5];
    expect(firstEvalId).toBeTruthy();
    expect(secondEvalId).toBeTruthy();
    expect(secondEvalId).not.toBe(firstEvalId);
  });

  it("quizRetry 复用上一次的 evalId（失败重试 → 服务端重放已结算帧）", async () => {
    mockEvalStream();
    renderHook(() => useAppStore());

    await flushQuizAnswer("2");
    const firstEvalId = evalSubmitMock.mock.calls[0]![5];

    await act(async () => {
      await quizRetry();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(evalSubmitMock).toHaveBeenCalledTimes(2);
    expect(evalSubmitMock.mock.calls[1]![5]).toBe(firstEvalId);
  });

  it("quizNext 推进后 lastEvalId 重置", async () => {
    mockEvalStream();
    renderHook(() => useAppStore());

    await flushQuizAnswer("2");
    await act(async () => {
      await quizNext();
    });
    expect(useAppStore.getState().quiz.lastEvalId).toBeNull();
    expect(useAppStore.getState().quiz.lastAnswer).toBeNull();
  });
});
