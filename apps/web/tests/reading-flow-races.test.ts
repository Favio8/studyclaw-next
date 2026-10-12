import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  readingLoad: vi.fn(), readingSaveProgress: vi.fn(), readingAddHighlight: vi.fn(),
  cardDraft: vi.fn(), cardCommit: vi.fn(),
  readingExport: vi.fn(),
  progress: vi.fn(), mastery: vi.fn(), heatmap: vi.fn(), readingTraces: vi.fn(), digest: vi.fn(),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));

import { useAppStore } from "../src/store/useAppStore";
import {
  readingOpenAt, readingOpen, readingSaveProgress, readingAddHighlight, readingDraftCard,
  readingDismissCardDraft, readingCommitCard,
  readingExportAnnotations,
} from "../src/lib/readingFlow";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const selection = { text: "原文", prefix: "", suffix: "", page: 1, rects: [], x: 0, y: 0 };
const record = {
  id: "old-highlight", page: 1, rects: [], quote: { text: "原文", prefix: "", suffix: "" },
  color: "yellow" as const, comment: "", tags: [], conceptId: null, createdAt: "",
};
function payload(source: string) {
  return { source, view: "pdf" as const, exists: true, progress: { page: 1, percent: 0 }, highlights: [], recovered: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.getState().setWorkspacePath("/project/a");
  useAppStore.getState().setActiveCourse("a");
  apiMocks.readingLoad.mockImplementation(async (source: string) => payload(source));
  apiMocks.readingTraces.mockResolvedValue({ traces: [] });
  apiMocks.digest.mockResolvedValue({ dueCount: 0, concepts: [], recentHighlights: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe("阅读异步响应归属", () => {
  it("英文选区与概念名称大小写不同仍能关联", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setPanelData({ progress: { overallMastery: 0, dueCount: 0, lastUpdatedAt: null, concepts: [
      { id: "memory", name: "Memory for Large Language Models", chapter: "", mastery: 0, evals: 0, passRate: 0, ef: 2.5, nextReviewAt: null, misattribution: "none", exposure: 0 },
    ] } });
    useAppStore.getState().setReader({ selection: { ...selection, text: "memory for large language models" } });
    apiMocks.readingAddHighlight.mockResolvedValue(record);
    await readingAddHighlight("yellow");
    expect(apiMocks.readingAddHighlight.mock.calls[0]?.[1].conceptId).toBe("memory");
  });
  it("划线后更新今天摘要，无需重开课程", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setReader({ selection });
    apiMocks.readingAddHighlight.mockResolvedValue(record);
    await readingAddHighlight("yellow");
    await vi.waitFor(() => expect(useAppStore.getState().digest?.recentHighlights).toBe(1));
  });
  it("同一 PDF 连续点击两条引用时，晚到的旧装载不能把页码跳回去", async () => {
    const old = deferred<ReturnType<typeof payload>>();
    apiMocks.readingLoad.mockReturnValueOnce(old.promise);
    const pending = readingOpenAt("a.pdf", 4);
    await readingOpenAt("a.pdf", 9);
    old.resolve(payload("a.pdf"));
    await pending;
    expect(useAppStore.getState().reader.progress.page).toBe(9);
    expect(apiMocks.readingSaveProgress).not.toHaveBeenCalled();
  });

  it("慢资料装载不能覆盖后打开的资料", async () => {
    const old = deferred<ReturnType<typeof payload>>();
    apiMocks.readingLoad.mockReturnValueOnce(old.promise);
    const pending = readingOpen("a.pdf");
    await readingOpen("b.pdf");
    old.resolve(payload("a.pdf"));
    await pending;
    expect(useAppStore.getState().reader.source).toBe("b.pdf");
  });

  it("切到同名课程的新项目后，旧装载错误不得污染阅读器", async () => {
    const old = deferred<ReturnType<typeof payload>>();
    apiMocks.readingLoad.mockReturnValueOnce(old.promise);
    const pending = readingOpen("a.pdf");
    useAppStore.getState().setWorkspacePath("/another/a");
    useAppStore.getState().setActiveCourse("a");
    old.reject(new Error("旧项目错误"));
    await pending;
    expect(useAppStore.getState().reader.error).toBeNull();
    expect(useAppStore.getState().reader.source).toBeNull();
  });

  it("A → B → A 后首个 A 的装载不得覆盖新 A", async () => {
    const old = deferred<ReturnType<typeof payload>>();
    apiMocks.readingLoad.mockReturnValueOnce(old.promise);
    const pending = readingOpen("a.pdf");
    await readingOpen("b.pdf");
    await readingOpen("a.pdf");
    old.resolve({ ...payload("a.pdf"), progress: { page: 99, percent: 99 } });
    await pending;
    expect(useAppStore.getState().reader.progress.page).toBe(1);
  });

  it("装载新资料时立即清除旧资料的标注和草稿", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setReader({ highlights: [record], cardDraft: { task: { question: "旧题" }, quote: "", busy: false, error: null } });
    const next = deferred<ReturnType<typeof payload>>();
    apiMocks.readingLoad.mockReturnValueOnce(next.promise);
    const pending = readingOpen("b.pdf");
    const reader = useAppStore.getState().reader;
    expect(reader.highlights).toEqual([]);
    expect(reader.cardDraft).toBeNull();
    next.resolve(payload("b.pdf"));
    await pending;
  });

  it("进度响应乱序时保留最近一次翻页", async () => {
    await readingOpen("a.pdf");
    const old = deferred<{ page: number; percent: number }>();
    apiMocks.readingSaveProgress.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ page: 3, percent: 30 });
    const pending = readingSaveProgress(2, 20);
    await readingSaveProgress(3, 30);
    old.resolve({ page: 2, percent: 20 });
    await pending;
    expect(useAppStore.getState().reader.progress.page).toBe(3);
  });

  it("旧资料的高亮请求完成后不能给新资料添加标注或清空选区", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setReader({ selection });
    const old = deferred<typeof record>();
    apiMocks.readingAddHighlight.mockReturnValueOnce(old.promise);
    const pending = readingAddHighlight("yellow");
    await readingOpen("b.pdf");
    useAppStore.getState().setReader({ selection });
    old.resolve(record);
    await pending;
    expect(useAppStore.getState().reader.highlights).toEqual([]);
    expect(useAppStore.getState().reader.selection).toEqual(selection);
  });

  it("关闭生成中的草稿后，晚到响应不能重开面板", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setReader({ selection });
    const old = deferred<{ draft: Record<string, unknown> }>();
    apiMocks.cardDraft.mockReturnValueOnce(old.promise);
    const pending = readingDraftCard();
    readingDismissCardDraft();
    old.resolve({ draft: { question: "旧题" } });
    await pending;
    expect(useAppStore.getState().reader.cardDraft).toBeNull();
  });

  it("旧课程的建卡失败不能重新显示到新课程", async () => {
    await readingOpen("a.pdf");
    useAppStore.getState().setReader({ cardDraft: { task: { question: "旧题" }, quote: "", busy: false, error: null } });
    const old = deferred<void>();
    apiMocks.cardCommit.mockReturnValueOnce(old.promise);
    const pending = readingCommitCard({ question: "旧题" });
    useAppStore.getState().setActiveCourse("b");
    old.reject(new Error("旧建卡失败"));
    await pending;
    expect(useAppStore.getState().reader.cardDraft).toBeNull();
  });

  it.each(["不可用", "拒绝"])("剪贴板%s时不能报告导出成功", async (condition) => {
    await readingOpen("a.pdf");
    apiMocks.readingExport.mockResolvedValue({ markdown: "# 标注", count: 1 });
    vi.stubGlobal("navigator", { clipboard: condition === "不可用" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("无剪贴板权限")) } });
    await readingExportAnnotations();
    expect(useAppStore.getState().modeBanner).toContain("导出失败");
  });
});
