import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { quizLoad, quizReset, storeState } = vi.hoisted(() => {
  const quizLoad = vi.fn();
  const quizReset = vi.fn();
  // 测试 mock：宽松类型（any），允许各用例按场景改写 quiz 状态而不受
  // 字面量推断的窄类型约束。
  const storeState: any = {
    activeCourseId: "course-1",
    setQuiz: vi.fn(),
    quiz: {
      mode: "review",
      tasks: [
        {
          taskId: "task-1",
          conceptId: "concept-1",
          type: "concept",
          difficulty: 2,
          question: "什么是调度？",
          options: ["分配", "删除"],
          answerIndex: 1,
          answerRationale: "调度的本质是分配。",
        },
      ],
      index: 0,
      phase: "idle",
      rubrics: [],
      result: null,
      sm2: null,
      error: null,
      loading: false,
      lastAnswer: null,
      answerText: "",
    },
  };
  return { quizLoad, quizReset, storeState };
});

vi.mock("../src/store/useAppStore", () => ({
  // 测试 mock：宽松类型，允许各用例按场景改写 quiz 状态
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/quizFlow", () => ({
  quizLoad,
  quizReset,
  quizAnswer: vi.fn(),
  quizNext: vi.fn(),
  quizRetry: vi.fn(),
}));

import QuizTab from "../src/components/panel/QuizTab";

afterEach(() => {
  cleanup();
  quizLoad.mockClear();
  quizReset.mockClear();
});

describe("QuizTab", () => {
  it("uses an accessible segmented control for review and new questions", () => {
    render(<QuizTab />);

    expect(screen.getByRole("button", { name: "复习" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "新题" }));
    expect(quizLoad).toHaveBeenCalledWith("new");
  });

  it("选项按钮带垂直内边距与顶部对齐（多行长选项不顶边框）", () => {
    storeState.quiz.tasks = [
      {
        taskId: "task-long",
        conceptId: "concept-1",
        type: "concept",
        difficulty: 3,
        question: "长选项渲染",
        options: [
          "很短",
          "这是一个非常非常长的正确选项表述，包含大量限定词与边界条件，用来验证多行折行后不再顶到边框",
        ],
        answerIndex: 1,
        answerRationale: null,
      },
    ];
    render(<QuizTab />);

    const longOption = screen.getByRole("button", { name: /这是一个非常非常长的正确选项表述/ });
    expect(longOption.className).toContain("py-2");
    expect(longOption.className).toContain("items-start");
    expect(longOption.querySelector("span.min-w-0")?.className).toContain("overflow-wrap:anywhere");
  });

  it("答错后：正确项绿色高亮并显示「正确答案」行", () => {
    storeState.quiz.tasks = [
      {
        taskId: "task-key",
        conceptId: "concept-1",
        type: "concept",
        difficulty: 2,
        question: "Harness 的本质是什么？",
        options: ["模型内部推理模块", "连接模型与真实环境的控制系统"],
        answerIndex: 1,
        answerRationale: "Harness 是控制系统。",
      },
    ];
    storeState.quiz.phase = "done";
    storeState.quiz.lastAnswer = "模型内部推理模块";
    storeState.quiz.rubrics = [
      { index: 0, criterion: "要点一", hit: false },
      { index: 1, criterion: "要点二", hit: false },
    ];
    storeState.quiz.result = { score: 0, passed: false, feedback: "正确答案：连接模型与真实环境的控制系统。", misconceptions: [] };

    render(<QuizTab />);

    const wrong = screen.getByRole("button", { name: /模型内部推理模块/ });
    expect(wrong.className).toContain("border-accent-fail");
    const correct = screen.getByRole("button", { name: /连接模型与真实环境的控制系统/ });
    expect(correct.className).toContain("border-accent-pass");
    expect(screen.getByText(/正确答案：B/)).toBeDefined();
  });
});
