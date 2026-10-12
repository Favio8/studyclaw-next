import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ progress: vi.fn(), mastery: vi.fn(), heatmap: vi.fn(), readingTraces: vi.fn(), digest: vi.fn(),
  courseList: vi.fn(), quiz: vi.fn(), evalSubmit: vi.fn(), evalTrend: vi.fn() }));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
import { useAppStore } from "../src/store/useAppStore";
import { refreshPanelData } from "../src/lib/panelData";
import { quizAnswer, quizLoad } from "../src/lib/quizFlow";
import type { ProgressPayload } from "../src/types/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const progress = (value: number): ProgressPayload => ({ overallMastery: value, dueCount: 0, lastUpdatedAt: null, concepts: [] });
const task = { taskId: "fixture", conceptId: "c1", type: "concept", question: "?", difficulty: 1, options: null, answerIndex: null, answerRationale: null };
function switchProject(path: string) {
  useAppStore.getState().setWorkspacePath(path);
  useAppStore.getState().setActiveCourse("same-name");
}
beforeEach(() => {
  vi.resetAllMocks();
  switchProject("/first/same-name");
  apiMocks.progress.mockResolvedValue(progress(0.3));
  apiMocks.mastery.mockResolvedValue(null);
  apiMocks.heatmap.mockResolvedValue(null);
  apiMocks.readingTraces.mockResolvedValue({ traces: [] });
  apiMocks.digest.mockResolvedValue({ dueCount: 0, concepts: [], recentHighlights: 0 });
  apiMocks.courseList.mockResolvedValue({ courses: [] });
  apiMocks.evalSubmit.mockImplementation(async function* () {
    yield { event: "result", data: { score: 1, passed: true, feedback: "fixture", misconceptions: [] } };
  });
});
afterEach(() => vi.useRealTimers());

describe("项目上下文不能只用课程名判断", () => {
  it("同名新项目的面板刷新不能复用旧项目在途请求", async () => {
    const old = deferred<ProgressPayload>();
    apiMocks.progress.mockReturnValueOnce(old.promise);
    const first = refreshPanelData();
    switchProject("/another/same-name");
    const second = refreshPanelData();
    try { expect(apiMocks.progress).toHaveBeenCalledTimes(2); }
    finally { old.resolve(progress(0.9)); await Promise.all([first, second]); }
    expect(useAppStore.getState().progress?.overallMastery).toBe(0.3);
  });

  it("A → B → A 后旧 A 的面板响应不能覆盖重新打开的 A", async () => {
    const old = deferred<ProgressPayload>();
    apiMocks.progress.mockReturnValueOnce(old.promise);
    const first = refreshPanelData();
    switchProject("/another/same-name");
    switchProject("/first/same-name");
    const latest = refreshPanelData();
    old.resolve(progress(0.9));
    await Promise.all([first, latest]);
    expect(useAppStore.getState().progress?.overallMastery).toBe(0.3);
  });

  it.each(["success", "error"])("同名切项目后旧题卡 %s 响应不写回", async (result) => {
    const old = deferred<{ tasks: typeof task[] }>();
    apiMocks.quiz.mockReturnValueOnce(old.promise);
    const pending = quizLoad("new");
    switchProject("/another/same-name");
    if (result === "success") old.resolve({ tasks: [task] });
    else old.reject(new Error("旧项目失败"));
    await pending;
    expect(useAppStore.getState().quiz.tasks).toEqual([]);
    expect(useAppStore.getState().quiz.error).toBeNull();
  });

  it("复习/新卡切换时只采纳最后一次加载", async () => {
    const old = deferred<{ tasks: typeof task[] }>();
    apiMocks.quiz.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ tasks: [{ ...task, taskId: "new" }] });
    const first = quizLoad("review");
    await quizLoad("new");
    old.resolve({ tasks: [task] });
    await first;
    expect(useAppStore.getState().quiz.tasks[0]?.taskId).toBe("new");
  });

  it("扫描动画期间切项目不能再向新项目发送旧题评测", async () => {
    vi.useFakeTimers();
    useAppStore.getState().setQuiz({ tasks: [task], phase: "answering" });
    const pending = quizAnswer("fixture");
    switchProject("/another/same-name");
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(apiMocks.evalSubmit).not.toHaveBeenCalled();
    expect(useAppStore.getState().quiz.phase).toBe("idle");
  });
});
