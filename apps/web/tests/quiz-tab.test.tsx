import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { quizLoad, quizReset, storeState, createSessionMock } = vi.hoisted(() => {
  const quizLoad = vi.fn();
  const quizReset = vi.fn();
  const createSessionMock = vi.fn();
  // 测试 mock：宽松类型（any），允许各用例按场景改写 quiz 状态而不受
  // 字面量推断的窄类型约束。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩需按场景改写形状
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
      styleSuggestion: null,
    },
  };
  return { quizLoad, quizReset, storeState, createSessionMock };
});

vi.mock("../src/store/useAppStore", () => ({
  // 测试 mock：宽松类型，允许各用例按场景改写 quiz 状态
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 storeState 同理
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/quizFlow", () => ({
  quizLoad,
  quizReset,
  quizAnswer: vi.fn(),
  quizNext: vi.fn(),
  quizRetry: vi.fn(),
}));
vi.mock("../src/hooks/useSessionActions", () => ({
  useSessionActions: () => ({ createSession: createSessionMock }),
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

  it("连续未过显示换风格建议卡；点击以该风格开新对话并聚焦概念", () => {
    storeState.quiz.phase = "done";
    storeState.quiz.result = { score: 0.2, passed: false, feedback: "再想想依赖的方向。", misconceptions: [] };
    storeState.quiz.styleSuggestion = { conceptId: "concept-1", consecutiveFailures: 3 };
    storeState.progress = { concepts: [{ id: "concept-1", name: "调度" }] };
    storeState.setMode = vi.fn();
    storeState.setFocusConcept = vi.fn();
    storeState.flashStatusBanner = vi.fn();

    render(<QuizTab />);

    expect(screen.getByText(/连续 3 次未通过/)).toBeDefined();
    expect(screen.getByText(/换个方式学/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "费曼输出" }));
    expect(storeState.setMode).toHaveBeenCalledWith("feynman");
    expect(storeState.setFocusConcept).toHaveBeenCalledWith("concept-1");
    expect(storeState.setQuiz).toHaveBeenCalledWith({ styleSuggestion: null });
    expect(createSessionMock).toHaveBeenCalled();
    expect(storeState.flashStatusBanner).toHaveBeenCalled();

    // 收尾：清掉建议，避免泄漏到后续用例
    storeState.quiz.styleSuggestion = null;
    storeState.quiz.phase = "idle";
    storeState.quiz.result = null;
  });

  it("无建议时不渲染建议卡", () => {
    storeState.quiz.phase = "done";
    storeState.quiz.result = { score: 0.2, passed: false, feedback: "", misconceptions: [] };
    storeState.quiz.styleSuggestion = null;
    render(<QuizTab />);
    expect(screen.queryByText(/换个方式学/)).toBeNull();
  });

  describe("M2 回顾原文", () => {
    const HINTS = [
      { text: "SM-2 的 EF 钳制在 [1.3, 2.9]", prefix: "上文", suffix: "下文", source: "a.pdf", page: 3 },
      { text: "间隔序列 I(1)=1、I(2)=6", prefix: "", suffix: "", source: "a.pdf", page: 7 },
    ];

    beforeEach(() => {
      storeState.quiz.phase = "idle";
      storeState.quiz.result = null;
      storeState.quiz.lastAnswer = null;
      storeState.quiz.styleSuggestion = null;
      storeState.quiz.tasks = [
        {
          taskId: "task-hint",
          conceptId: "concept-1",
          type: "concept",
          difficulty: 2,
          question: "EF 如何钳制？",
          options: ["[1.3, 2.9]", "不钳制"],
          answerIndex: 0,
          answerRationale: null,
          hints: HINTS,
        },
      ];
    });

    it("作答前默认折叠，不把线索摊在眼前；点击可展开", () => {
      render(<QuizTab />);
      const toggle = screen.getByRole("button", { name: /回顾原文（2）/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/EF 钳制在/)).toBeNull();

      fireEvent.click(toggle);
      expect(screen.getByText(/EF 钳制在/)).toBeDefined();
      expect(screen.getByText(/a\.pdf p\.3/)).toBeDefined();
    });

    it("作答后自动展开", () => {
      storeState.quiz.phase = "done";
      storeState.quiz.lastAnswer = "[1.3, 2.9]";
      storeState.quiz.result = { score: 1, passed: true, feedback: "对", misconceptions: [] };
      render(<QuizTab />);
      expect(screen.getByText(/EF 钳制在/)).toBeDefined();
      expect(screen.getByRole("button", { name: "收起原文" })).toHaveAttribute("aria-expanded", "true");
    });

    it("无 hints 时不留空占位", () => {
      delete storeState.quiz.tasks[0].hints;
      render(<QuizTab />);
      expect(screen.queryByRole("button", { name: /回顾原文/ })).toBeNull();
    });
  });
});
