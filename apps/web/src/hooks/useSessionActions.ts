"use client";

/**
 * 对话动作（T3.2 + T3.3）：列表装载 / 选中恢复 / 新建。
 *
 * 选中对话 = GET 恢复端点 → 历史消息整渲染（瞬时，不做流式回放）
 *  + 对话横幅（已恢复（上次 …））+ suggestedEntry；
 * 新建对话 = POST → 空消息中栏 + 新对话横幅；
 * 切换/新建前先 abortActiveChat() 中止旧流（跨 hook 单例，lib/chatStream）。
 *
 * UI-9：selectSession 携带选择纪元——restore 返回时若期间发生了更新的
 * 选择（手动连点/自动选会话），晚到的响应直接放弃落地，杜绝"点了 B 却
 * 进了 A"的乱序覆盖。
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
import {
  bumpSelectEpoch,
  consumeSuppress,
  peekSelectEpoch,
  suppressAutoSelectOnce,
} from "@/src/lib/selectEpoch";
import { nextMessageId, useAppStore } from "@/src/store/useAppStore";

// A7：纪元状态下沉到 lib/selectEpoch（打破 sessionActions 的循环导入）；
// 这里 re-export 保持 LeftNav 及其测试的既有导入路径不变。
export { suppressAutoSelectOnce };

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
    // UI-9：记录本次选择占据的纪元；restore 在途期间若出现更新的选择
    // （纪元已变），晚到的响应放弃落地。
    const myEpoch = bumpSelectEpoch();
    try {
      const restored = await api.restoreSession(courseId, sessionId);
      // Resume the shared Host Agent so subsequent chat turns use one live
      // lifecycle owner instead of rebuilding a Web-only runner.
      await api.resumeAgent(courseId, sessionId).catch(() => undefined);
      if (peekSelectEpoch() !== myEpoch) return; // 更新的选择已发生，本次晚到响应作废
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
      // 标题由面包屑第二段展示，横幅不再重复一遍（旧实现"对话：<title> · 已恢复"
      // 让同一标题在 header 里出现两次）。
      setSessionBanner(
        lastDate
          ? `── 已恢复上次对话 · ${lastDate} ──`
          : `── 已恢复上次对话 ──`,
      );
    } catch {
      if (peekSelectEpoch() !== myEpoch) return; // 同上：过期响应不落地失败态
      setActiveSession(sessionId, "");
      setMessages([]);
      setSuggestedEntry(null);
      useAppStore.getState().setWakeupCard(null);
      // 恢复失败同样要清掉上一对话的挂起提问占位符（防串对话残留）
      useAppStore.getState().setPendingAsk(null);
      // UI-3：恢复失败时 activeSessionId 仍指向旧会话，横幅不能谎称"新对话"。
      setSessionBanner(`── 恢复失败 · 请重试或新建对话 ──`);
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
  // UI-9：suppressAutoSelectOnce 标记的切换（切项目同时选了具体会话/新建）
  // 跳过自动选会话，避免"列表第一条"晚到覆盖用户的显式选择。
  useEffect(() => {
    if (!activeCourseId) return;
    abortActiveChat();
    const courseId = activeCourseId;
    if (consumeSuppress(courseId)) {
      // UI-9：suppress 跳过的是"自动选第一条会话"，不是列表刷新本身——
      // 触发场景（全局搜索跨项目打开会话/新建后切换）用户已显式选定目标，
      // 但左栏列表仍需加载，否则进入课程后会话列表空白，须手动刷新才有。
      void loadSessions(courseId);
      return;
    }
    const epochAtStart = peekSelectEpoch();
    let run = autoSelectRuns.get(courseId);
    if (run === undefined) {
      run = (async () => {
        const sessions = await loadSessions(courseId);
        if (useAppStore.getState().activeCourseId !== courseId || peekSelectEpoch() !== epochAtStart) return;
        if (sessions.length > 0) {
          void selectSession(sessions[0].sessionId, courseId);
        } else {
          if (useAppStore.getState().activeCourseId !== courseId || peekSelectEpoch() !== epochAtStart) return;
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
