/**
 * W-2 回归：quizLoad 落地前必须校验 activeCourseId——await 期间用户切项目时，
 * 旧课程的题卡不得覆盖新课程的 quiz 状态（Console.tsx / panelData.ts 均有同类
 * 守卫，唯独 quizFlow 缺失）：覆盖后再作答即用新 courseId + 旧 taskId 提交。
 */

import { describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    quiz: {
      mode: "review" as const,
      loading: false,
      error: null as string | null,
      tasks: [] as unknown[],
      index: 0,
      phase: "idle" as const,
      rubrics: [] as unknown[],
      result: null as unknown,
      sm2: null as unknown,
      lastAnswer: null as string | null,
      lastEvalId: null as string | null,
      answerText: "",
    },
    activeCourseId: "course-1",
    activeSessionId: null as string | null,
    setQuiz: vi.fn(),
    setMascotPulse: vi.fn(),
    flashStatusBanner: vi.fn(),
  },
  apiMocks: {
    quiz: vi.fn(),
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
  notifyPanelChanged: vi.fn(),
  refreshCourseList: vi.fn(() => Promise.resolve()),
  refreshPanelData: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/lib/chatStream", () => ({ isAbortError: () => false }));

import { quizLoad } from "../src/lib/quizFlow";

const STALE_TASKS = [{ task_id: "old-course-task", concept_id: "c_1" }]

describe("quizLoad 切课守卫（W-2）", () => {
  it("await 期间切项目：旧课程题卡不覆盖新课程 quiz", async () => {
    storeState.setQuiz.mockClear();
    let resolveQuiz!: (value: { tasks: unknown[] }) => void;
    apiMocks.quiz.mockReturnValue(new Promise(resolve => { resolveQuiz = resolve }))
    const pending = quizLoad("review")
    // 拉取在途时用户切到其他项目。
    storeState.activeCourseId = "course-2"
    resolveQuiz({ tasks: STALE_TASKS })
    await pending
    // 只有一次 setQuiz（进入 loading 的重置）；题卡落地的那次被守卫拦下。
    expect(storeState.setQuiz).toHaveBeenCalledTimes(1)
    expect(storeState.setQuiz.mock.calls[0]![0]).toMatchObject({ loading: true })
    storeState.activeCourseId = "course-1"
  })

  it("未切项目：题卡正常落地（守卫不误伤）", async () => {
    storeState.setQuiz.mockClear();
    apiMocks.quiz.mockResolvedValue({ tasks: STALE_TASKS })
    await quizLoad("review")
    expect(storeState.setQuiz).toHaveBeenCalledTimes(2)
    expect(storeState.setQuiz.mock.calls[1]![0]).toMatchObject({ loading: false, tasks: STALE_TASKS })
  })
})
