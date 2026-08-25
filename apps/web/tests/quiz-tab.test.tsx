import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { quizLoad, quizReset, storeState } = vi.hoisted(() => {
  const quizLoad = vi.fn();
  const quizReset = vi.fn();
  return {
    quizLoad,
    quizReset,
    storeState: {
      activeCourseId: "course-1",
      setQuiz: vi.fn(),
      quiz: {
        mode: "review" as const,
        tasks: [
          {
            taskId: "task-1",
            conceptId: "concept-1",
            type: "concept",
            difficulty: 2,
            question: "什么是调度？",
            options: ["分配", "删除"],
          },
        ],
        index: 0,
        phase: "idle" as const,
        rubrics: [],
        result: null,
        sm2: null,
        error: null,
        loading: false,
        lastAnswer: null,
        answerText: "",
      },
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
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
});
