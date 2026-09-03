/**
 * 对话动作纯函数层（T3.5）：口令（Ctrl+N / Palette 新建对话）与
 * useSessionActions 共用同一实现。
 *
 * createNewSession：中止旧流 → **空对话复用**（DSH 语义：当前项目已存在
 * 0 轮次的空白对话时不重复创建，直接选中该占位行）→ 无则 POST 新对话 →
 * 刷新左栏列表 → 激活 + 清空消息 + 对话横幅；无课程时静默返回 false。
 */

import { api } from "@/src/lib/api";
import { abortActiveChat } from "@/src/lib/chatStream";
import { modeLabel } from "@/src/lib/modes";
// A7：从独立模块导入，消除与 useSessionActions 的循环依赖。
import { suppressAutoSelectOnce } from "@/src/lib/selectEpoch";
import { useAppStore } from "@/src/store/useAppStore";

/** 指定课程下新建对话（空对话复用）；返回是否成功。
 * UI-22：失败原因在函数内部以横幅呈现（无项目 vs 请求失败此前都由调用方
 * 统一提示"未选择项目"，网络失败时文案误导）。 */
export async function createNewSession(title?: string, targetCourseId?: string): Promise<boolean> {
  const state = useAppStore.getState();
  const courseId = targetCourseId ?? state.activeCourseId;
  if (!courseId) {
    state.flashStatusBanner("未选择项目，无法新建对话");
    return false;
  }
  if (courseId !== state.activeCourseId) {
    // UI-9：本次调用明确了"新建对话"目标，抑制目标课程的自动选会话，
    // 防止下方空对话复用/新建落地后被 effect 的列表第一条恢复覆盖。
    suppressAutoSelectOnce(courseId);
    state.setActiveCourse(courseId);
  }
  abortActiveChat();
  state.setStreaming(false);

  // 空对话防叠加：已有 0 轮次的占位对话 → 直接复用选中（DSH tree.ts 语义）
  const { sessions } = await api.sessions(courseId).catch(() => ({ sessions: [] }));
  const loaded = useAppStore.getState();
  loaded.setCourseSessions(courseId, sessions);
  if (loaded.activeCourseId === courseId) loaded.setSessions(sessions);
  const blank = sessions.find((session) => session.turns === 0);
  if (blank) {
    const fresh = useAppStore.getState();
    fresh.setActiveSession(blank.sessionId, blank.title);
    fresh.setMessages([]);
    fresh.setSuggestedEntry(null);
    fresh.setWakeupCard(null);
    fresh.setPendingAsk(null);
    fresh.setSessionBanner(
      `── 新对话 · ${modeLabel(fresh.mode)}模式 ──`,
    );
    return true;
  }

  const mode = useAppStore.getState().mode;
  try {
    const created = await api.newSession(courseId, mode, title);
    const sessionId = created.sessionId;
    const { sessions: refreshed } = await api.sessions(courseId);
    const fresh = useAppStore.getState();
    fresh.setCourseSessions(courseId, refreshed);
    if (fresh.activeCourseId === courseId) {
      fresh.setSessions(refreshed);
      fresh.setActiveSession(sessionId, title ?? "");
      fresh.setMessages([]);
      fresh.setSuggestedEntry(null);
      fresh.setWakeupCard(created.wakeup ?? null);
      fresh.setPendingAsk(null);
      fresh.setSessionBanner(`── 新对话 · ${modeLabel(fresh.mode)}模式 ──`);
    }
    return true;
  } catch (cause) {
    useAppStore.getState().setWakeupCard(null);
    useAppStore
      .getState()
      .flashStatusBanner(`✗ 新建对话请求失败：${cause instanceof Error ? cause.message : String(cause)}，请稍后重试`);
    return false;
  }
}
