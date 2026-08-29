"use client";

/**
 * 项目打开/切换的共享动作（DSH WorkspacePicker 语义，M1 版）。
 *
 * 「新建项目」向导、左栏切换器与并列树都走 `adoptWorkspace`：幂等接管目录
 * → 拉取该项目课程列表 → 整体采纳进 store。M1 尚无对话/构建后端（M2/M3
 * 回归），设置拉取失败静默降级。最近路径同步写 localStorage 作为服务端注册表
 * 之外的双保险。
 */

import { api } from "@/src/lib/api";
import { modeLabel } from "@/src/lib/modes";
import { useAppStore } from "@/src/store/useAppStore";
import type { OpenWorkspaceResponse } from "@/src/types/api";

export const LAST_WORKSPACE_KEY = "studyclaw:last-workspace";

export function recordLastWorkspace(path: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, path);
  } catch {
    // 浏览器存储不可用时静默：服务端注册表仍是主数据源。
  }
}

/** 读取"最近打开的项目"（服务端注册表不可达时的启动兜底）。 */
export function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export async function adoptWorkspace(path: string): Promise<OpenWorkspaceResponse> {
  const opened = await api.openWorkspace(path);
  const [settings, list] = await Promise.all([
    api.settings().catch(() => null),
    api.workspaceCourses(opened.workspace.path),
  ]);
  const store = useAppStore.getState();

  store.setCourses(list.courses);
  store.setWorkspacePath(opened.workspace.path);
  store.setActiveCourse(list.courses[0]?.id ?? null);
  store.setActiveSession(null, "");
  store.setMessages([]);
  // FL-17：横幅文案读同一状态源的默认模式，不再硬编码「苏格拉底模式」。
  const mode = settings?.ui.defaultMode;
  if (mode) store.setMode(mode);
  store.setSessionBanner(`── 新对话 · ${modeLabel(mode ?? useAppStore.getState().mode)}模式 ──`);
  // FL-18：自动建课骨架失败时后端以 courseWarning 透传——旧版被吞，用户拿到
  // 一个零提示的空项目。
  if (opened.courseWarning) {
    store.flashStatusBanner(`⚠ 项目已打开，但自动初始化课程骨架失败：${opened.courseWarning}`);
  }
  store.setBuildStatus("done");
  recordLastWorkspace(opened.workspace.path);
  return opened;
}

/** M2 对话引擎回归后恢复（build 任务轮询）。 */
export async function monitorBuildJob(jobId: string, courseId: string): Promise<void> {
  const setBuildStatus = useAppStore.getState().setBuildStatus;
  try {
    for (let attempt = 0; attempt < 3600; attempt += 1) {
      const job = await api.job(jobId);
      if (job.status === "done") {
        if (useAppStore.getState().activeCourseId === courseId) {
          setBuildStatus("done");
        }
        return;
      }
      if (job.status === "failed") throw new Error(job.error ?? "课程索引构建失败");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("课程索引构建超时（30 分钟仍未完成）");
  } catch (cause) {
    if (useAppStore.getState().activeCourseId === courseId) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setBuildStatus("failed");
      useAppStore.getState().flashStatusBanner(`✗ ${message}`);
    }
  }
}
