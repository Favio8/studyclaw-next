/**
 * 概念补题编排（PRD F2）：只读覆盖统计 + 任务启动、进度轮询与停止。
 *
 * store 保持纯同步（同 quizFlow/readingFlow 的模式）；轮询是模块级单例——
 * ProgressTab / SyllabusTab / ReaderView 同时挂载同一面板，不能各自起一份轮询。
 * 所有写回都校验激活课程，切课后旧任务结果不显示到新课程。
 */

import { api } from "@/src/lib/api";
import { refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";
import type { ConceptFillJobView } from "@/src/types/api";

const POLL_INTERVAL_MS = 1200;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 只读覆盖统计（不发送模型请求）。 */
export async function loadConceptCardStatus(): Promise<void> {
  const courseId = useAppStore.getState().activeCourseId;
  if (courseId === null) {
    useAppStore.getState().setConceptCardStatus(null);
    return;
  }
  try {
    const status = await api.conceptCardStatus(courseId);
    if (useAppStore.getState().activeCourseId !== courseId) return;
    useAppStore.getState().setConceptCardStatus(status);
  } catch {
    // 覆盖统计读取失败不阻塞其他面板；下次刷新会重试。
  }
}

function applyJob(courseId: string, job: ConceptFillJobView): void {
  useAppStore.getState().setConceptFill({
    courseId,
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    coveredBefore: job.coveredBefore,
    processed: job.processed,
    generated: job.generated,
    currentConcept: job.currentConcept,
    items: job.items,
    error: job.error,
    sharedProblem: job.sharedProblem,
  });
}

/** 补题成功/停止后同步刷新右栏（进度/摘要）、大纲与题池。 */
async function syncAfterRun(): Promise<void> {
  useAppStore.getState().bumpCourseDataRevision();
  await Promise.allSettled([refreshPanelData(), loadConceptCardStatus()]);
}

function finishSummary(job: ConceptFillJobView): string {
  const filled = job.items.filter((item) => item.status === "filled").length;
  const failed = job.items.filter((item) => item.status === "failed").length;
  const unprocessed = job.items.filter((item) => item.status === "unprocessed").length;
  if (job.status === "stopped") return `已停止：已保存 ${job.generated} 张题卡`;
  if (job.status === "failed") return `补题失败：${job.error ?? "未知原因"}`;
  if (failed === 0 && unprocessed === 0) return `为 ${filled} 个概念新增 ${job.generated} 张题卡`;
  return `已为 ${filled} 个概念新增 ${job.generated} 张；${failed} 个失败、${unprocessed} 个未处理`;
}

async function poll(courseId: string, jobId: string): Promise<void> {
  stopPolling();
  const state = useAppStore.getState();
  // 切课后放弃旧课程的轮询（结果不迁移到新课）。
  if (state.activeCourseId !== courseId || state.conceptFill.jobId !== jobId) return;
  try {
    const job = await api.conceptCardFillStatus(jobId);
    const current = useAppStore.getState();
    if (current.activeCourseId !== courseId) { stopPolling(); return; }
    if (job.courseId !== courseId) { stopPolling(); return; }
    applyJob(courseId, job);
    if (job.status === "running") {
      pollTimer = setTimeout(() => void poll(courseId, jobId), POLL_INTERVAL_MS);
      return;
    }
    await syncAfterRun();
    useAppStore.getState().flashStatusBanner(finishSummary(job));
  } catch (exc) {
    const current = useAppStore.getState();
    if (current.activeCourseId !== courseId) return;
    useAppStore.getState().setConceptFill({ status: "failed", error: errorMessage(exc) });
  }
}

/** 启动补题（只补缺题概念；后端按真实题池重算缺题清单）。 */
export async function startConceptFill(): Promise<void> {
  const courseId = useAppStore.getState().activeCourseId;
  if (courseId === null) return;
  stopPolling();
  useAppStore.getState().setConceptFill({
    courseId, jobId: null, status: "running", total: 0, coveredBefore: 0,
    processed: 0, generated: 0, currentConcept: null, items: [], error: null, sharedProblem: null,
  });
  try {
    const { jobId } = await api.conceptCardFillStart(courseId);
    if (useAppStore.getState().activeCourseId !== courseId) return;
    useAppStore.getState().setConceptFill({ jobId });
    void poll(courseId, jobId);
  } catch (exc) {
    useAppStore.getState().setConceptFill({ status: "failed", error: errorMessage(exc) });
  }
}

/** 停止：后端取消后台模型请求，保留已落盘题卡。 */
export async function stopConceptFill(): Promise<void> {
  const { conceptFill } = useAppStore.getState();
  if (conceptFill.jobId === null) return;
  const jobId = conceptFill.jobId;
  const courseId = conceptFill.courseId;
  stopPolling();
  try {
    const job = await api.conceptCardFillStop(jobId);
    if (courseId !== null) applyJob(courseId, job);
    await syncAfterRun();
    useAppStore.getState().flashStatusBanner(finishSummary(job));
  } catch (exc) {
    useAppStore.getState().setConceptFill({ status: "failed", error: errorMessage(exc) });
  }
}

/** 重试：重新读取当前课程状态，只处理仍缺题的概念（即再次 start）。 */
export async function retryConceptFill(): Promise<void> {
  await startConceptFill();
}
