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

/** 同一课程的并发刷新合并为一次在途请求——Console/ChatArea/Palette 多实例
 * 的 usePanelData effect 此前各自打满三路请求，落地顺序不定还互相覆盖。 */
const inflightByKey = new Map<string, Promise<void>>();

/** progress/mastery/heatmap 三路并行刷新（读取 store 当前激活课程）。 */
export async function refreshPanelData(): Promise<void> {
  const requestedCourseId = useAppStore.getState().activeCourseId;
  if (!requestedCourseId) return;
  // 同一课程的并发刷新合并为一次在途请求（多实例 effect 去重）。
  const existing = inflightByKey.get(requestedCourseId);
  if (existing !== undefined) return await existing;
  const task = (async () => {
    await runPanelRefresh(requestedCourseId);
  })();
  inflightByKey.set(requestedCourseId, task);
  try {
    await task;
  } finally {
    if (inflightByKey.get(requestedCourseId) === task) inflightByKey.delete(requestedCourseId);
  }
}

async function runPanelRefresh(courseId: string): Promise<void> {
  const [progress, mastery, heatmap] = await Promise.allSettled([
    api.progress(courseId),
    api.mastery(courseId),
    api.heatmap(12),
  ]);
  // 进度一路失败必须显式落错（否则 ProgressTab 只有骨架屏可渲染，
  // 出现「大纲正常、进度永远转圈」的割裂画面）。
  const progressError =
    progress.status === "fulfilled"
      ? null
      : progress.reason instanceof Error
        ? progress.reason.message
        : String(progress.reason);
  // FE-3：落地前必须仍属于发起时的课程——快速切课时旧课程的慢响应
  // 不允许覆盖新课的骨架数据。
  if (useAppStore.getState().activeCourseId !== courseId) return;
  useAppStore.getState().setPanelData({
    progress: progress.status === "fulfilled" ? progress.value : null,
    progressError,
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
  } catch (error) {
    // PERF-6：不再完全静默——横幅一次性提示；左栏下次装载仍会重试。
    console.warn("[panelData] 课程列表刷新失败:", error);
    useAppStore.getState().flashStatusBanner("✗ 课程列表加载失败，稍后自动重试");
  }
}

/** 数据变化角标：目标 Tab 未激活时点亮；查看（setActiveTab）即清除。 */
export function notifyPanelChanged(tab: PanelTab): void {
  const state = useAppStore.getState();
  if (state.activeTab !== tab) {
    state.toggleBadge(tab, true);
  }
}
