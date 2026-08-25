/**
 * 右栏面板数据装载（T3.4）：store 与 hooks 共用的纯函数层。
 *
 * - `refreshPanelData`：progress / mastery / heatmap 三路并行（任一失败不阻塞
 *   其余，面板各自渲染错误占位）；供 usePanelData（courseId 变化）与 store
 *   action（eval done / chat sync / `/sync` 后）调用——不经过 hook 也能刷新。
 * - `refreshCourseList`：重拉课程列表（左栏 Due 徽标随评测/同步变化）。
 * - `notifyPanelChanged`：角标策略——数据变化而对应 Tab 未激活时点亮 `●`，
 *   setActiveTab 已实现「查看即清除」。
 */

import { useAppStore } from "@/src/store/useAppStore";
import type { PanelTab } from "@/src/store/useAppStore";
import { api } from "@/src/lib/api";

/** progress/mastery/heatmap 三路并行刷新（读取 store 当前激活课程）。 */
export async function refreshPanelData(): Promise<void> {
  const { activeCourseId } = useAppStore.getState();
  if (!activeCourseId) return;
  const [progress, mastery, heatmap] = await Promise.allSettled([
    api.progress(activeCourseId),
    api.mastery(activeCourseId),
    api.heatmap(12),
  ]);
  useAppStore.getState().setPanelData({
    progress: progress.status === "fulfilled" ? progress.value : null,
    mastery: mastery.status === "fulfilled" ? mastery.value : null,
    heatmap: heatmap.status === "fulfilled" ? heatmap.value : null,
  });
}

/** 重拉课程列表（评测/同步后 Due 徽标、掌握度更新；M1 起按项目读取）。 */
export async function refreshCourseList(): Promise<void> {
  try {
    const workspacePath = useAppStore.getState().workspacePath;
    if (!workspacePath) return;
    const { courses } = await api.courseList(workspacePath);
    useAppStore.getState().setCourses(courses);
  } catch {
    /* 静默：左栏下次装载再修正 */
  }
}

/** 数据变化角标：目标 Tab 未激活时点亮；查看（setActiveTab）即清除。 */
export function notifyPanelChanged(tab: PanelTab): void {
  const state = useAppStore.getState();
  if (state.activeTab !== tab) {
    state.toggleBadge(tab, true);
  }
}
