"use client";

/**
 * 对话动作（T3.2 + T3.3）：列表装载 / 选中恢复 / 新建。
 *
 * 选中对话 = GET 恢复端点 → 历史消息整渲染（瞬时，不做流式回放）
 *  + 对话横幅（已恢复（上次 …））+ suggestedEntry；
 * 新建对话 = POST → 空消息中栏 + 新对话横幅；
 * 切换/新建前先 abortActiveChat() 中止旧流（跨 hook 单例，lib/chatStream）。
 *
 * 注：函数不手动 memoize——React Compiler（Next 16 默认）自动接管，
 * 避免 useCallback 闭包与 effect 前向引用的编译器冲突（T3.2 修正）。
 */

import { useEffect } from "react";
import { abortActiveChat } from "@/src/lib/chatStream";
import { dateOnly } from "@/src/lib/format";
import { modeLabel } from "@/src/lib/modes";
import { api } from "@/src/lib/api";
import { createNewSession } from "@/src/lib/sessionActions";
import { nextMessageId, useAppStore } from "@/src/store/useAppStore";

/** 模块级（跨所有 useSessionActions 实例共享）：手动选择纪元 + 自动选会话去重。 */
let selectEpoch = 0;
const autoSelectRuns = new Map<string, Promise<void>>();

export function useSessionActions() {
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const setSessions = useAppStore((s) => s.setSessions);
  const setCourseSessions = useAppStore((s) => s.setCourseSessions);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setMessages = useAppStore((s) => s.setMessages);
  const setSessionBanner = useAppStore((s) => s.setSessionBanner);
  const setSuggestedEntry = useAppStore((s) => s.setSuggestedEntry);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);

  /** 用户主动选中对话的计数：自动选会话 effect 完成前若发生了任何手动
   * 选择，就不再覆盖用户的选择（FE-2 竞态守卫）。 */
  function bumpSelectEpoch() {
    return ++selectEpoch;
  }

  async function loadSessions(courseId: string) {
    try {
      const { sessions } = await api.sessions(courseId);
      setCourseSessions(courseId, sessions);
      if (courseId === useAppStore.getState().activeCourseId) setSessions(sessions);
      return sessions;
    } catch {
      if (courseId === useAppStore.getState().activeCourseId) setSessions([]);
      return [];
    }
  }

  async function selectSession(sessionId: string, courseId = activeCourseId) {
    if (!courseId) return;
    if (courseId !== useAppStore.getState().activeCourseId) setActiveCourse(courseId);
    abortActiveChat(); // 中止旧流（若在流式）
    useAppStore.getState().setStreaming(false);
    bumpSelectEpoch();
    try {
      const restored = await api.restoreSession(courseId, sessionId);
      // Resume the shared Host Agent so subsequent chat turns use one live
      // lifecycle owner instead of rebuilding a Web-only runner.
      await api.resumeAgent(courseId, sessionId).catch(() => undefined);
      setActiveSession(sessionId, restored.title);
      setMessages(
        restored.turns.map((turn) => ({
          id: nextMessageId(),
          role: turn.role,
          content: turn.content,
          createdAt: turn.ts,
        })),
      );
      setSuggestedEntry(restored.suggestedEntry);
      useAppStore.getState().setWakeupCard(restored.wakeup ?? null);
      useAppStore.getState().setPendingAsk(restored.pendingAsk ?? null);
      const meta = useAppStore
        .getState()
        .sessions.find((s) => s.sessionId === sessionId);
      const lastDate = meta?.lastActiveAt ? dateOnly(meta.lastActiveAt) : null;
      setSessionBanner(
        lastDate
          ? `── 对话：${restored.title || "（未命名对话）"} · 已恢复（上次 ${lastDate}）──`
          : `── 对话：${restored.title || "（未命名对话）"} · 已恢复 ──`,
      );
    } catch {
      setActiveSession(sessionId, "");
      setMessages([]);
      setSuggestedEntry(null);
      useAppStore.getState().setWakeupCard(null);
      // 恢复失败同样要清掉上一对话的挂起提问占位符（防串对话残留）
      useAppStore.getState().setPendingAsk(null);
      setSessionBanner(`── 新对话 · ${modeLabel(useAppStore.getState().mode)}模式 ──`);
    }
  }

  async function createSession(title?: string, courseId?: string) {
    // 统一走 lib/sessionActions（Ctrl+N / Palette 共用同一实现）
    await createNewSession(title, courseId);
  }

  async function renameSession(sessionId: string, title: string, courseId = activeCourseId) {
    if (!courseId) return;
    const result = await api.renameSession(courseId, sessionId, title);
    await loadSessions(courseId);
    if (courseId === useAppStore.getState().activeCourseId && useAppStore.getState().activeSessionId === sessionId) {
      setActiveSession(sessionId, result.title);
    }
    return result;
  }

  async function forkSession(sessionId: string, courseId = activeCourseId, chatIndex?: number) {
    if (!courseId) return null;
    const result = await api.forkSession(courseId, sessionId, chatIndex);
    await loadSessions(courseId);
    await selectSession(result.sessionId, courseId);
    return result;
  }

  async function archiveSession(sessionId: string, courseId = activeCourseId) {
    if (!courseId) return null;
    await api.archiveSession(courseId, sessionId);
    const sessions = await loadSessions(courseId);
    const current = useAppStore.getState();
    if (courseId !== current.activeCourseId || sessionId !== current.activeSessionId) return sessions;
    const next = sessions[0];
    if (next) {
      await selectSession(next.sessionId, courseId);
    } else {
      setActiveSession(null);
      setMessages([]);
      setSuggestedEntry(null);
      useAppStore.getState().setWakeupCard(null);
      useAppStore.getState().setPendingAsk(null);
      setSessionBanner(`── 新对话 · ${modeLabel(useAppStore.getState().mode)}模式 ──`);
    }
    return sessions;
  }

  async function reorderSession(sessionId: string, beforeId: string | undefined, courseId = activeCourseId) {
    if (!courseId) return null;
    const result = await api.reorderSession(courseId, sessionId, beforeId);
    setCourseSessions(courseId, result.sessions);
    if (courseId === useAppStore.getState().activeCourseId) setSessions(result.sessions);
    return result.sessions;
  }

  // 项目切换 → 对话列表刷新 + 默认恢复最近对话（列表第一项，§3.2）
  // FE-2：双实例收敛 + 归属守卫——同一课程的自动选择以模块级 promise 去重；
  // 完成时若课程已再切换或期间发生过手动选择，则放弃覆盖。
  useEffect(() => {
    if (!activeCourseId) return;
    abortActiveChat();
    const courseId = activeCourseId;
    const epochAtStart = selectEpoch;
    let run = autoSelectRuns.get(courseId);
    if (run === undefined) {
      run = (async () => {
        const sessions = await loadSessions(courseId);
        if (useAppStore.getState().activeCourseId !== courseId || selectEpoch !== epochAtStart) return;
        if (sessions.length > 0) {
          void selectSession(sessions[0].sessionId, courseId);
        } else {
          if (useAppStore.getState().activeCourseId !== courseId || selectEpoch !== epochAtStart) return;
          setActiveSession(null);
          setMessages([]);
          setSuggestedEntry(null);
          setSessionBanner(
            `── 新对话 · ${modeLabel(useAppStore.getState().mode)}模式 ──`,
          );
        }
      })();
      autoSelectRuns.set(courseId, run);
      void run.finally(() => {
        if (autoSelectRuns.get(courseId) === run) autoSelectRuns.delete(courseId);
      });
    }
  }, [activeCourseId]);

  return { loadSessions, selectSession, createSession, renameSession, forkSession, archiveSession, reorderSession };
}
