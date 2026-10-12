/**
 * AI 阅读概括编排（PRD F3）：SSE 消费（stage/progress/result/done/error）、
 * 停止取消后台模型请求、保存到笔记与发送到对话。
 *
 * 与划词动作分离：概括不依赖选区，且面板关闭/切资料/切课都必须取消在途请求，
 * 旧响应不得覆盖新阅读对象。store 保持纯同步。
 */

import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { SummaryResultView } from "@/src/types/api";

let summaryAbort: AbortController | null = null;

export function abortActiveSummary(): void {
  if (summaryAbort !== null) {
    summaryAbort.abort();
    summaryAbort = null;
  }
}

/** 请求只能写回发起时的项目/课程/资料打开周期。 */
function summaryScopeIsCurrent(): () => boolean {
  const start = useAppStore.getState();
  const { workspacePath, activeCourseId, readerGeneration, courseGeneration } = start;
  const source = start.reader.source;
  return () => {
    const current = useAppStore.getState();
    return current.workspacePath === workspacePath && current.activeCourseId === activeCourseId
      && current.readerGeneration === readerGeneration && current.courseGeneration === courseGeneration
      && current.reader.source === source;
  };
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 打开概括面板（不发起请求）。 */
export function openSummaryPanel(): void {
  const { reader } = useAppStore.getState();
  if (reader.source === null) return;
  const phase = reader.summary?.result?.fromCache === true ? "已载入缓存" : "准备概括…";
  useAppStore.getState().setReader({
    summary: { scope: reader.summary?.scope ?? "document", phase, progress: null, streaming: false, result: reader.summary?.result ?? null, error: null },
  });
}

/** 关闭面板即结束本次生成（取消后台模型请求）。 */
export function closeSummaryPanel(): void {
  abortActiveSummary();
  useAppStore.getState().setReader({ summary: null });
}

/** 切换范围只改选择，不自动请求；由用户点「生成」触发。 */
export function setSummaryScope(scope: "document" | "chapter"): void {
  const { reader } = useAppStore.getState();
  if (reader.summary === null) return;
  useAppStore.getState().setReader({ summary: { ...reader.summary, scope } });
}

/**
 * 生成概括。`force` = 用户明确点「重新生成」（忽略缓存）。
 * 后端按所选范围完整遍历正文；已完成的缓存命中不会再次调用模型。
 */
export async function runReadingSummary(force = false): Promise<void> {
  const state = useAppStore.getState();
  const source = state.reader.source;
  if (source === null || state.activeCourseId === null) return;
  const scope = state.reader.summary?.scope ?? "document";
  const currentPage = state.reader.progress.page;
  abortActiveSummary();
  const abort = new AbortController();
  summaryAbort = abort;
  const isCurrent = summaryScopeIsCurrent();
  const request = () => useAppStore.getState().reader.summary;
  useAppStore.getState().setReader({
    summary: {
      scope,
      phase: "正在读取正文…",
      progress: null,
      streaming: true,
      result: force ? null : state.reader.summary?.result ?? null,
      error: null,
    },
  });
  try {
    for await (const frame of api.readingSummarize(source, { scope, currentPage, force }, abort.signal)) {
      if (abort.signal.aborted || !isCurrent()) return;
      const current = request();
      if (current === null) return;
      if (frame.event === "stage") {
        useAppStore.getState().setReader({ summary: { ...current, phase: frame.data.message, streaming: true } });
      } else if (frame.event === "progress") {
        useAppStore.getState().setReader({
          summary: { ...current, phase: `概括第 ${frame.data.current}/${frame.data.total} 段`, progress: { current: frame.data.current, total: frame.data.total }, streaming: true },
        });
      } else if (frame.event === "result") {
        useAppStore.getState().setReader({ summary: { ...current, result: frame.data, streaming: true } });
      } else if (frame.event === "error") {
        useAppStore.getState().setReader({ summary: { ...current, streaming: false, error: frame.data.message ?? frame.data.code ?? "概括失败" } });
        return;
      }
    }
    if (abort.signal.aborted || !isCurrent()) return;
    const done = request();
    if (done !== null) {
      const phase = done.result === null ? "未完成" : done.result.coverage.complete === false ? "部分完成" : "完成";
      useAppStore.getState().setReader({ summary: { ...done, phase, streaming: false } });
    }
  } catch (exc) {
    if (abort.signal.aborted || !isCurrent()) return;
    const current = request();
    if (current !== null) useAppStore.getState().setReader({ summary: { ...current, streaming: false, error: errorMessage(exc) } });
  } finally {
    if (summaryAbort === abort) summaryAbort = null;
  }
}

/** 停止：取消后台模型请求；已生成内容标记未完成，不写完整结果缓存（后端保证）。 */
export function stopReadingSummary(): void {
  abortActiveSummary();
  const { reader } = useAppStore.getState();
  if (reader.summary === null) return;
  useAppStore.getState().setReader({ summary: { ...reader.summary, streaming: false, phase: "已停止" } });
}

/** 概括结果 → Markdown（保存笔记 / 发送对话共用，带上资料名与范围）。 */
export function summaryToMarkdown(result: SummaryResultView): string {
  const lines: string[] = [`## AI 概括 · ${result.source}`];
  lines.push(`范围：${result.scope === "chapter" ? `当前章节「${result.chapterTitle ?? ""}」` : "当前资料"}`);
  if (result.range !== null) lines.push(`页码：第 ${result.range.startPage}–${result.range.endPage} 页`);
  lines.push(`生成时间：${result.generatedAt}`);
  lines.push("", "### 一句话概览", result.overview, "", "### 核心要点");
  result.points.forEach((point, index) => {
    const pages = [...new Set(point.evidence.map((evidence) => evidence.page))].join("、");
    lines.push(`${index + 1}. ${point.text}（出处：第 ${pages} 页）`);
  });
  if (result.concepts.length > 0) {
    lines.push("", "### 关键概念");
    for (const concept of result.concepts) lines.push(`- **${concept.name}**：${concept.explanation}`);
  }
  if (result.suggestions.length > 0) {
    lines.push("", "### 建议先读（AI 阅读建议）");
    for (const suggestion of result.suggestions) lines.push(`- ${suggestion.label} → 第 ${suggestion.page} 页：${suggestion.reason}`);
  }
  return lines.join("\n");
}

/** 保存到课程笔记 notes.md（用户主动动作）。 */
export async function saveSummaryToNotes(): Promise<void> {
  const { reader } = useAppStore.getState();
  const result = reader.summary?.result;
  if (reader.source === null || result === undefined || result === null) return;
  const isCurrent = summaryScopeIsCurrent();
  try {
    const { appended } = await api.readingAppendSummary(reader.source, summaryToMarkdown(result));
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(appended ? "✓ 概括已保存到课程笔记 notes.md" : "没有可保存的内容");
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✗ 保存到笔记失败: ${errorMessage(exc)}`);
  }
}

/** 发送到对话：把概括与出处作为引用卡带入输入框，允许继续追问。 */
export function sendSummaryToChat(): void {
  const state = useAppStore.getState();
  const result = state.reader.summary?.result;
  if (result === null || result === undefined) return;
  const key = `${state.workspacePath ?? ""}\0${state.activeCourseId ?? ""}\0${state.activeSessionId ?? "new"}`;
  const page = result.range?.startPage ?? 1;
  state.setComposerReference(key, {
    source: result.source,
    page,
    quote: result.scope === "chapter" ? `当前章节：${result.chapterTitle ?? "（未命名）"}` : "当前资料",
    result: summaryToMarkdown(result),
    kind: "summary",
  });
  state.setCenterView("chat");
}
