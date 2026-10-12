/**
 * 辅助阅读编排（PRD 需求三）：资料装载、进度、标注 CRUD、导出与划词 LLM
 * 动作的 SSE 消费。store 保持纯同步（同 quizFlow 的模式）；活跃阅读流句柄
 * 是模块级单例，切走阅读活动/切换项目时统一 abort。
 */

import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { AnnotationView } from "@/src/types/api";
import type { ReaderSelection } from "@/src/store/useAppStore";
import { refreshPanelData } from "@/src/lib/panelData";
import { abortActiveSummary } from "@/src/lib/summaryFlow";

/** 模块级「活跃阅读流」中止句柄（单例；与 quizFlow 的 eval 流同语义）。 */
let activeAbort: AbortController | null = null;
let progressRequest = 0;

/** 请求只能写回发起时的项目、课程和本次资料打开周期。 */
function readerScopeIsCurrent(): () => boolean {
  const start = useAppStore.getState();
  const { workspacePath, activeCourseId, readerGeneration, courseGeneration } = start;
  const source = start.reader.source;
  return () => {
    const current = useAppStore.getState();
    return current.workspacePath === workspacePath && current.activeCourseId === activeCourseId
      && current.readerGeneration === readerGeneration && current.reader.source === source
      && current.courseGeneration === courseGeneration;
  };
}

export function abortActiveReading(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Jump to evidence without saving it as reading progress; latest open owns the page.
 *  Same-source navigation must not reload/reset the reader——否则概括面板、划词与
 *  标注状态会被无谓清空（点击出处后无法继续看概括）。 */
export async function readingOpenAt(source: string, page: number): Promise<void> {
  const state = useAppStore.getState();
  if (state.reader.source === source && state.reader.error === null && !state.reader.loading) {
    state.setCenterView("reading");
    state.setReader({ progress: { ...state.reader.progress, page } });
    return;
  }
  useAppStore.getState().setCenterView("reading");
  const pending = readingOpen(source);
  const isCurrent = readerScopeIsCurrent();
  await pending;
  const next = useAppStore.getState();
  if (isCurrent() && next.reader.error === null) next.setReader({ progress: { ...next.reader.progress, page } });
}

/** 打开一份资料：读进度 + 标注，按扩展名决定视图。 */
export async function readingOpen(source: string): Promise<void> {
  // 先掐掉上一份资料的在途解释/翻译流：否则旧流的 token 会继续 append 进
  // 新资料的 action 卡（store 是共享单例）。概括同理：切资料必须取消在途请求，
  // 旧响应不得覆盖新阅读对象。
  abortActiveReading();
  abortActiveSummary();
  useAppStore.getState().readerReset();
  useAppStore.getState().setReader({ loading: true, error: null, source, selection: null, action: null });
  const isCurrent = readerScopeIsCurrent();
  try {
    const payload = await api.readingLoad(source);
    if (!isCurrent()) return;
    useAppStore.getState().setReader({
      loading: false,
      source,
      view: payload.view,
      exists: payload.exists,
      progress: { page: payload.progress.page, percent: payload.progress.percent },
      highlights: payload.highlights,
      recovered: payload.recovered,
      error: payload.exists ? null : "资料文件不存在或不在课程资料目录内（可能已被移动或删除）",
    });
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().setReader({ loading: false, error: errorMessage(exc) });
  }
}

/** 翻页即存（防抖由调用方做）：percent = floor(page/total*100)。 */
export async function readingSaveProgress(page: number, percent: number): Promise<void> {
  const { reader } = useAppStore.getState();
  if (reader.source === null) return;
  const isCurrent = readerScopeIsCurrent();
  const request = ++progressRequest;
  try {
    const progress = await api.readingSaveProgress(reader.source, page, percent);
    if (!isCurrent() || request !== progressRequest) return;
    useAppStore.getState().setReader({ progress: { page: progress.page, percent: progress.percent } });
  } catch {
    // 进度保存失败不打断阅读（下次翻页会再存）。
  }
}

/**
 * 概念建议（P3）：用右栏已装载的进度数据（concept id + name）对选区做
 * 名称包含匹配——命中则随高亮落库，未命中为 null。纯启发式，不写掌握度。
 */
function suggestConceptId(text: string): string | null {
  const concepts = useAppStore.getState().progress?.concepts ?? [];
  if (concepts.length === 0 || text.trim() === "") return null;
  const needle = text.trim().toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const concept of concepts) {
    const name = concept.name?.trim().toLowerCase() ?? "";
    if (name === "" || name.length < 2) continue;
    let score = 0;
    if (needle.includes(name)) score = name.length;
    else if (name.includes(needle) && needle.length >= 4) score = needle.length;
    if (score > 0 && (best === null || score > best.score)) best = { id: concept.id, score };
  }
  return best?.id ?? null;
}

/** 划词高亮：用当前选区落一条标注（带概念建议）。 */
export async function readingAddHighlight(color: AnnotationView["color"]): Promise<void> {
  const { reader } = useAppStore.getState();
  const selection = reader.selection;
  if (reader.source === null || selection === null) return;
  const isCurrent = readerScopeIsCurrent();
  try {
    const record = await api.readingAddHighlight(reader.source, {
      page: selection.page,
      rects: selection.rects,
      quote: selection.text,
      prefix: selection.prefix,
      suffix: selection.suffix,
      color,
      comment: "",
      tags: [],
      conceptId: suggestConceptId(selection.text),
    });
    if (!isCurrent()) return;
    useAppStore.getState().setReader({
      highlights: [...useAppStore.getState().reader.highlights, record],
      ...(useAppStore.getState().reader.selection === selection ? { selection: null } : {}),
    });
    void refreshPanelData();
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✗ 标注失败: ${errorMessage(exc)}`);
  }
}

export async function readingRemoveHighlight(id: string): Promise<void> {
  const { reader } = useAppStore.getState();
  if (reader.source === null) return;
  const isCurrent = readerScopeIsCurrent();
  try {
    const { removed } = await api.readingRemoveHighlight(reader.source, id);
    if (!isCurrent()) return;
    if (removed) {
      useAppStore.getState().setReader({
        highlights: useAppStore.getState().reader.highlights.filter((item) => item.id !== id),
      });
      void refreshPanelData();
    }
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✗ 删除标注失败: ${errorMessage(exc)}`);
  }
}

/** 导出标注为 Markdown 并复制到剪贴板（用户主动动作，直接写不审批）。 */
export async function readingExportAnnotations(): Promise<void> {
  const { reader } = useAppStore.getState();
  if (reader.source === null) return;
  const isCurrent = readerScopeIsCurrent();
  try {
    const { markdown, count } = await api.readingExport(reader.source);
    if (!isCurrent()) return;
    if (count === 0) {
      useAppStore.getState().flashStatusBanner("这份资料还没有标注");
      return;
    }
    if (!navigator.clipboard) throw new Error("剪贴板不可用");
    await navigator.clipboard.writeText(markdown);
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✓ 已导出 ${count} 条标注到剪贴板`);
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✗ 导出失败: ${errorMessage(exc)}`);
  }
}

/** P3：导出标注追加到课程 notes.md（用户主动动作，直接写不审批）。 */
export async function readingAppendNotes(): Promise<void> {
  const { reader } = useAppStore.getState();
  if (reader.source === null) return;
  const isCurrent = readerScopeIsCurrent();
  try {
    const { appended, count } = await api.readingAppendNotes(reader.source);
    if (!isCurrent()) return;
    if (!appended) {
      useAppStore.getState().flashStatusBanner("这份资料还没有标注");
      return;
    }
    useAppStore.getState().flashStatusBanner(`✓ 已将 ${count} 条标注追加到课程笔记 notes.md`);
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().flashStatusBanner(`✗ 追加笔记失败: ${errorMessage(exc)}`);
  }
}

/** P3：划词建卡——生成草稿（不落盘），弹出确认面板。 */
export async function readingDraftCard(): Promise<void> {
  const { reader } = useAppStore.getState();
  const selection = reader.selection;
  const courseId = useAppStore.getState().activeCourseId;
  if (reader.source === null || selection === null || courseId === null) return;
  const scopeIsCurrent = readerScopeIsCurrent();
  const pending = { task: {}, quote: selection.text, busy: true, error: null };
  const isCurrent = () => scopeIsCurrent() && useAppStore.getState().reader.cardDraft === pending;
  useAppStore.getState().setReader({
    selection: null,
    cardDraft: pending,
  });
  try {
    const payload = await api.cardDraft(courseId, {
      content: `资料 ${reader.source} 中的这段内容：\n${selection.text}`,
      title: selection.text.slice(0, 30),
      conceptId: suggestConceptId(selection.text),
    });
    if (!isCurrent()) return;
    useAppStore.getState().setReader({
      cardDraft: { task: payload.draft, quote: selection.text, busy: false, error: null },
    });
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().setReader({
      cardDraft: { task: {}, quote: selection.text, busy: false, error: errorMessage(exc) },
    });
  }
}

/** P3：草稿确认落盘（题干可被用户编辑）。 */
export async function readingCommitCard(task: Record<string, unknown>): Promise<void> {
  const courseId = useAppStore.getState().activeCourseId;
  if (courseId === null) return;
  const current = useAppStore.getState().reader.cardDraft ?? { task, quote: "", busy: false, error: null };
  const scopeIsCurrent = readerScopeIsCurrent();
  const pending = { ...current, busy: true, error: null };
  const isCurrent = () => scopeIsCurrent() && useAppStore.getState().reader.cardDraft === pending;
  useAppStore.getState().setReader({ cardDraft: pending });
  try {
    await api.cardCommit(courseId, task);
    if (!isCurrent()) return;
    useAppStore.getState().setReader({ cardDraft: null });
    void refreshPanelData();
    useAppStore.getState().flashStatusBanner("✓ 已加入题卡池，将按 SM-2 排期");
  } catch (exc) {
    if (!isCurrent()) return;
    useAppStore.getState().setReader({ cardDraft: { ...current, busy: false, error: errorMessage(exc) } });
  }
}

export function readingDismissCardDraft(): void {
  useAppStore.getState().setReader({ cardDraft: null });
}

/** 选区变化（阅读器文本层 mouseup 后调用）。 */
export function readingSelectionChanged(selection: ReaderSelection | null): void {
  useAppStore.getState().setReader({ selection });
}

/**
 * 划词 LLM 动作（解释/翻译）：SSE 流式累积到 reader.action。
 * 失败静默中止仅限用户主动取消；其余错误落 error 态。
 */
export async function readingRunAction(kind: "explain" | "translate"): Promise<void> {
  const { reader } = useAppStore.getState();
  const selection = reader.selection;
  if (reader.source === null || selection === null) return;
  abortActiveReading();
  const abort = new AbortController();
  activeAbort = abort;
  const isCurrent = readerScopeIsCurrent();
  useAppStore.getState().setReader({
    action: { kind, streaming: true, text: "", error: null, reference: { source: reader.source, page: selection.page, quote: selection.text } },
    selection: null,
  });
  try {
    const stream = kind === "explain"
      ? api.readingExplain(reader.source, selection.text, abort.signal)
      : api.readingTranslate(reader.source, selection.text, abort.signal);
    for await (const frame of stream) {
      if (abort.signal.aborted || !isCurrent()) return;
      if (frame.event === "token") {
        const current = useAppStore.getState().reader.action;
        if (current === null) return;
        useAppStore.getState().setReader({
          action: { ...current, text: current.text + (frame.data.delta ?? "") },
        });
      } else if (frame.event === "error") {
        useAppStore.getState().setReader({
          action: { ...useAppStore.getState().reader.action!, kind, streaming: false, text: useAppStore.getState().reader.action?.text ?? "", error: frame.data.message ?? frame.data.code ?? "阅读动作失败" },
        });
        return;
      }
    }
    if (abort.signal.aborted || !isCurrent()) return;
    const done = useAppStore.getState().reader.action;
    if (done !== null) useAppStore.getState().setReader({ action: { ...done, streaming: false } });
  } catch (exc) {
    if (abort.signal.aborted || !isCurrent()) return;
    useAppStore.getState().setReader({
      action: { ...useAppStore.getState().reader.action!, kind, streaming: false, text: useAppStore.getState().reader.action?.text ?? "", error: errorMessage(exc) },
    });
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

export function readingDismissAction(): void {
  abortActiveReading();
  useAppStore.getState().setReader({ action: null });
}

/** 动作结果一键转正式对话（把选中文本与结论带入新对话）。 */
export async function readingContinueInChat(): Promise<void> {
  const state = useAppStore.getState();
  const { reader } = state;
  const action = reader.action;
  if (action?.reference === undefined) return;
  const key = `${state.workspacePath ?? ""}\0${state.activeCourseId ?? ""}\0${state.activeSessionId ?? "new"}`;
  state.setComposerReference(key, { ...action.reference, result: action.text, kind: action.kind });
  state.setCenterView("chat");
}
