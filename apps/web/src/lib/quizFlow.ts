/**
 * 🎯 题卡评测流编排（T3.4，api_spec §4）。
 *
 * - load(mode)：拉取题卡（review=SM-2 到期优先 / new=依赖解锁），重置状态；
 * - answer(answer)：POST /api/eval/submit SSE 六帧驱动：
 *   scan（本地 300ms 扫描线动画）→ rubric×N（相邻帧 ≥150ms 逐条节奏）
 *   → result（得分/通过/导师点拨）→ sm2（EF 变动）→ done（刷新面板+课程列表+角标）；
 * - 失败策略：**不自动重试**——服务端在产出帧前已同步落盘 settle 并回写
 *   progress/history，自动重试会重复评测计分；仅提供手动「重试」键。
 * - 中止：模块级单例（切换项目/重置时先 abortActiveEval()，AbortError 不
 *   视为错误、不污染新项目状态）。
 *
 * 状态全部落在 store.quiz（同步 setQuiz），本模块只负责时序编排——
 * 不经过 React hooks，键盘/指令/组件三处可共用。
 */

import { api } from "@/src/lib/api";
import {
  notifyPanelChanged,
  refreshCourseList,
  refreshPanelData,
} from "@/src/lib/panelData";
import { isAbortError } from "@/src/lib/chatStream";
import { useAppStore } from "@/src/store/useAppStore";
import type { QuizRubricItem } from "@/src/store/useAppStore";

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 模块级「活跃评测流」中止句柄（单例）。 */
let activeAbort: AbortController | null = null;

export function abortActiveEval(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/** 拉取题卡并重置到该模式首题。 */
export async function quizLoad(mode: "review" | "new", dueOnly = false): Promise<void> {
  const courseId = useAppStore.getState().activeCourseId;
  if (!courseId) return;
  abortActiveEval();
  useAppStore.getState().setQuiz({
    mode,
    loading: true,
    error: null,
    tasks: [],
    index: 0,
    phase: "idle",
    rubrics: [],
    result: null,
    sm2: null,
    lastAnswer: null,
    answerText: "",
  });
  try {
    const { tasks } = await api.quiz(courseId, mode, 5, dueOnly);
    // FL-28：池为空时旧实现只写入空数组，界面毫无反应（死胡同交互）——用户点
    // "开始练习"后既没有题也没有提示。这里显式给出可操作的下一步。
    useAppStore.getState().setQuiz({
      loading: false,
      tasks,
      error:
        tasks.length === 0
          ? mode === "review"
            ? "当前没有到期需要复习的题卡：可切换到「新卡」模式，或先构建课程。"
            : "题卡池为空：请先在对话框发送 /build 构建课程，生成题卡后再来练习。"
          : null,
    });
  } catch (exc) {
    useAppStore.getState().setQuiz({
      loading: false,
      error: `题卡加载失败: ${errorMessage(exc)}`,
    });
  }
}

/** 下一题：仍有剩余则推进；耗尽则按当前模式重拉（复习池随进度变化）。 */
export async function quizNext(): Promise<void> {
  const { quiz } = useAppStore.getState();
  if (quiz.tasks.length === 0) return;
  if (quiz.index + 1 < quiz.tasks.length) {
    useAppStore.getState().setQuiz({
      index: quiz.index + 1,
      phase: "idle",
      rubrics: [],
      result: null,
      sm2: null,
      error: null,
      lastAnswer: null,
      answerText: "",
    });
  } else {
    await quizLoad(quiz.mode);
  }
}

/** 提交作答并驱动六帧评测流。 */
export async function quizAnswer(answer: string): Promise<void> {
  const state = useAppStore.getState();
  const { quiz, activeCourseId, activeSessionId } = state;
  const text = answer.trim();
  if (!text || !activeCourseId) return;
  if (quiz.phase === "scanning" || quiz.phase === "evaluating") return;
  if (quiz.tasks.length === 0) return;
  const task = quiz.tasks[quiz.index];

  const abort = new AbortController();
  activeAbort = abort;
  useAppStore.getState().setQuiz({
    phase: "scanning",
    rubrics: [],
    result: null,
    sm2: null,
    error: null,
    lastAnswer: text,
    answerText: "",
  });

  // 扫描线动画窗口（300ms，ui_design_spec §3.3.1）
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (abort.signal.aborted) return;

  useAppStore.getState().setQuiz({ phase: "evaluating" });

  let lastRubricAt = 0;
  try {
    for await (const ev of api.evalSubmit(
      activeCourseId,
      task.taskId,
      text,
      activeSessionId,
      abort.signal,
    )) {
      switch (ev.event) {
        case "scan":
          break; // 扫描线已本地触发
        case "rubric": {
          const item: QuizRubricItem = {
            index: ev.data.index,
            criterion: ev.data.criterion,
            hit: ev.data.hit,
          };
          // 相邻采分点 ≥150ms 逐条弹出（到达过快时补延迟）
          const wait = Math.max(0, 150 - (Date.now() - lastRubricAt));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          lastRubricAt = Date.now();
          if (abort.signal.aborted) return;
          // PERF-7：整段换新数组 + 单次 setQuiz，避免每条采分点 O(n²) 全量拷贝。
          useAppStore.setState((prev) => ({
            quiz: { ...prev.quiz, rubrics: [...prev.quiz.rubrics, item] },
          }));
          break;
        }
        case "result": {
          useAppStore.getState().setQuiz({
            result: {
              score: ev.data.score,
              passed: ev.data.passed,
              feedback: ev.data.feedback,
              misconceptions: ev.data.misconceptions,
            },
          });
          // P0-⑤ + P1：quiz 结果触发爪爪脉冲——答对 celebrate（2400ms 举爪
          // 跳跃）、答错 encourage（4000ms 委屈拍拍加油，§7.2：与 alerting
          // 严格区分）。at 覆盖式更新，连续作答不会叠加脉冲。
          useAppStore.getState().setMascotPulse({
            at: Date.now(),
            kind: ev.data.passed ? "celebrate" : "encourage",
          });
          break;
        }
        case "sm2": {
          useAppStore.getState().setQuiz({
            sm2: {
              ef: ev.data.ef,
              efNew: ev.data.efNew,
              nextReviewAt: ev.data.nextReviewAt,
              masteryDelta: ev.data.masteryDelta,
            },
          });
          break;
        }
        case "done":
          break;
        case "warning": {
          // FL-09：后端 F-10 的可见告警帧（如 AUDIT_WRITE_FAILED）此前落进
          // default 分支被当"契约外"丢弃——修复只完成了服务端一半。这里以
          // 状态横幅显式呈现（评分流程继续，不算中断、不重试）。
          useAppStore
            .getState()
            .flashStatusBanner(`⚠ ${ev.data.message ?? ev.data.code ?? "评测告警"}`);
          break;
        }
        case "error": {
          throw new Error(`${ev.data.code}: ${ev.data.message}`);
        }
        default: {
          /* 未知事件：契约外，忽略 */
        }
      }
    }
    if (abort.signal.aborted) return;
    useAppStore.getState().setQuiz({ phase: "done" });
    // 结算后：面板/课程列表刷新 + 角标（左栏 Due、右栏数据、热力图）
    void refreshPanelData();
    void refreshCourseList();
    notifyPanelChanged("progress");
    notifyPanelChanged("quiz");
  } catch (exc) {
    if (isAbortError(exc) || abort.signal.aborted) return; // 用户切换/重置
    useAppStore.getState().setQuiz({
      phase: "idle",
      error: `评测中断: ${errorMessage(exc)}（可重试）`,
    });
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

/** 重试上一题（手动触发；不自动重试，避免重复 settle 计分）。 */
export async function quizRetry(): Promise<void> {
  const { lastAnswer } = useAppStore.getState().quiz;
  if (lastAnswer) await quizAnswer(lastAnswer);
}

/** 重置到初始态（切换项目/课程时由调用方触发）。 */
export function quizReset(): void {
  abortActiveEval();
  useAppStore.getState().quizReset();
}
