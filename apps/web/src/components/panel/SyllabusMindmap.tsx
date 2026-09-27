"use client";

/**
 * 大纲「思维导图视图」（P1 迭代，B1 mind-elixir 5.15）：章节 = 一级分支、
 * 概念 = 叶子；掌握度状态色点 + 百分比 + 「N 依赖」角标（tooltip 列先修
 * 概念名）。只读展示（editable=false），保留折叠/展开。
 *
 * P1 关键改进（相对初版）：
 * - init 一次、后续数据变化走 `refresh()`（不再 destroy/reinit，折叠不丢）；
 * - 容器尺寸为 0 时不初始化（右栏 Tab 常驻 hidden 修复）、ResizeObserver
 *   驱动「适配视图」自动缩放；
 * - 「适配视图 / 1:1」缩放模式切换 + 放大/缩小/展开全部/收起全部/导出 PNG；
 * - 节点样式全部走 globals.css `.studyclaw-mindmap` 作用域（Token 驱动）；
 * - focusConceptId 外部联动：自动展开父分支 + 选中 + 滚动定位；
 *   导图内点击不再强切回列表视图。
 *
 * 由 SyllabusTab 经 next/dynamic({ ssr: false }) 惰性加载。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MindElixir from "mind-elixir";
import type { MindElixirData, NodeObj } from "mind-elixir";
import "mind-elixir/style.css";
import { Download, Focus, FoldVertical, UnfoldVertical, ZoomIn, ZoomOut } from "lucide-react";
import { toPng } from "html-to-image";
import type { Syllabus } from "@/src/types";
import type { ConceptStatus } from "@/src/components/panel/SyllabusGraph";
import { buildPrereqNames, projectToMindmap, type MindmapConceptMeta, type MindmapNode } from "@/src/lib/syllabusMindmapData";
import { CHAPTER_COLORS } from "@/src/components/panel/SyllabusGraph";

export { buildPrereqNames, projectToMindmap, type MindmapConceptMeta };

/** 缩放下限/上限（与 mind-elixir options 一致；scaleFit 可能无下限缩小）。 */
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.8;
/** 收起分支重新展开后的定位重试次数上限。 */
const FOCUS_RETRY = 3;

const MINIMAP_THEME = {
  name: "studyclaw",
  type: "light" as const,
  palette: [...CHAPTER_COLORS],
  cssVar: {
    "--main-color": "var(--color-text-primary)",
    "--main-bgcolor": "var(--color-bg-panel)",
    "--main-border": "1px solid var(--color-border-line)",
    "--color": "var(--color-text-primary)",
    "--bgcolor": "var(--color-bg-panel)",
    "--root-color": "var(--color-bg-panel)",
    "--root-bgcolor": "var(--color-accent-focus)",
    "--root-border-color": "var(--color-accent-focus)",
    "--selected": "var(--color-accent-focus)",
    "--accent-color": "var(--color-accent-focus)",
    "--node-gap-x": "26px",
    "--node-gap-y": "6px",
    "--main-gap-x": "48px",
    "--main-gap-y": "36px",
    "--map-padding": "24px",
  },
};

interface SyllabusMindmapProps {
  syllabus: Syllabus;
  statusMap: Record<string, ConceptStatus>;
  focusConceptId: string | null;
  collapsed: Record<string, boolean>;
  searchQuery: string;
  onToggleCollapse: (chapterId: string, collapsed: boolean) => void;
  onFocusConcept: (conceptId: string, name: string) => void;
}

/** 找到 target 的祖先链（含自身）；返回 [root, …, target]。 */
function ancestry(root: MindmapNode | undefined, targetId: string): MindmapNode[] | null {
  if (root === undefined) return null;
  if (root.id === targetId) return [root];
  for (const child of root.children ?? []) {
    const found = ancestry(child, targetId);
    if (found !== null) return [root, ...found];
  }
  return null;
}

export default function SyllabusMindmap({
  syllabus,
  statusMap,
  focusConceptId,
  collapsed,
  searchQuery,
  onToggleCollapse,
  onFocusConcept,
}: SyllabusMindmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [fitMode, setFitMode] = useState<"fit" | "1:1">("fit");
  const [exporting, setExporting] = useState(false);

  const mindRef = useRef<MindElixir | null>(null);
  const dataRef = useRef<MindElixirData | null>(null);
  const appliedDataRef = useRef<MindElixirData | null>(null);
  const suppressSelectRef = useRef(false);
  const selfSelectedRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ id: string; retries: number } | null>(null);
  const onFocusRef = useRef(onFocusConcept);
  const onToggleRef = useRef(onToggleCollapse);
  const fitModeRef = useRef(fitMode);

  const prereqNames = useMemo(() => buildPrereqNames(syllabus), [syllabus]);
  const data: MindElixirData = useMemo(
    () =>
      projectToMindmap(syllabus, statusMap, prereqNames, {
        collapsed,
        searchQuery,
        direction: 2, // MindElixir.SIDE
      }) as MindElixirData,
    [collapsed, prereqNames, searchQuery, statusMap, syllabus],
  );

  // 保持 refs 与当前 render 同步（一次性事件监听 / 布局函数需要最新值）。
  useEffect(() => {
    onFocusRef.current = onFocusConcept;
    onToggleRef.current = onToggleCollapse;
    fitModeRef.current = fitMode;
    dataRef.current = data;
  });

  /** 适配视图：scaleFit 后钳制最小缩放值（不把整图缩到不可读）。 */
  const fitToCanvas = useCallback(() => {
    const mind = mindRef.current;
    if (mind === null) return;
    mind.scaleFit();
    if (mind.scaleVal < SCALE_MIN) {
      mind.scale(SCALE_MIN);
      mind.toCenter();
    }
  }, []);

  // 容器可见（尺寸 > 0）后才视为 ready；RightPanel 常驻 hidden 时尺寸为 0。
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        const first = !ready;
        setReady(true);
        if (fitModeRef.current === "fit") fitToCanvas();
        if (first && pendingFocusRef.current !== null) {
          // 初始化窗口打开前收到聚焦请求：延迟到 init 后再定位。
          pendingFocusRef.current.retries += 1;
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitToCanvas, ready]);

  const selectAndScroll = useCallback((conceptId: string) => {
    const mind = mindRef.current;
    if (mind === null || conceptId === "") return;
    let tpc: ReturnType<MindElixir["findEle"]> | null = null;
    try {
      tpc = mind.findEle(conceptId);
    } catch {
      return;
    }
    if (tpc === null || tpc === undefined) return;
    suppressSelectRef.current = true;
    try {
      mind.selectNode(tpc);
      mind.scrollIntoView(tpc, true);
    } finally {
      suppressSelectRef.current = false;
    }
  }, []);

  /** 展开到 target 的所有收起祖先；返回是否有需要展开的分支。 */
  const openAncestorsIfNeeded = useCallback((conceptId: string): boolean => {
    const root = (dataRef.current?.nodeData ?? null) as unknown as MindmapNode | null;
    const chain = root ? ancestry(root, conceptId) : null;
    if (chain === null) return false;
    let changed = false;
    for (const node of chain) {
      if (typeof node.id === "string" && node.id.startsWith("chap:") && (node.expanded ?? true) === false) {
        onToggleRef.current(node.id.slice("chap:".length), false);
        changed = true;
      }
    }
    return changed;
  }, []);

  // init once：构建 MindElixir 实例 + 一次性事件监听。
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (el === null) return;
    const mind = new MindElixir({
      el,
      editable: false,
      contextMenu: false,
      toolBar: false,
      keypress: false,
      allowUndo: false,
      direction: MindElixir.SIDE,
      compact: true,
      scaleMin: SCALE_MIN,
      scaleMax: SCALE_MAX,
      theme: MINIMAP_THEME,
    });
    const initError = mind.init(dataRef.current!);
    if (initError !== undefined) {
      setError(String(initError));
      mind.destroy();
      return;
    }
    mindRef.current = mind;
    appliedDataRef.current = dataRef.current;
    const onSelect = (nodes: NodeObj[]) => {
      const meta = nodes[0]?.metadata as unknown as MindmapConceptMeta | undefined;
      if (meta?.conceptId === undefined || meta.conceptId === "") return;
      if (suppressSelectRef.current) return;
      selfSelectedRef.current = meta.conceptId;
      onFocusRef.current(meta.conceptId, nodes[0]!.topic);
    };
    const onExpand = (node: NodeObj) => {
      if (typeof node.id !== "string" || !node.id.startsWith("chap:")) return;
      onToggleRef.current(node.id.slice("chap:".length), node.expanded === false);
    };
    mind.bus.addListener("selectNodes", onSelect);
    mind.bus.addListener("expandNode", onExpand);
    if (fitModeRef.current === "fit") fitToCanvas();
    // 首次 init 消费 ready 之前到达的聚焦请求：init 把当前数据标记为"已应用"
    // 后，refresh effect 会因 data === appliedDataRef 提前返回，pending 若不
    // 在这里消费就永远无人处理（首次打开导图时外部聚焦失效的根因）。
    const pendingInit = pendingFocusRef.current;
    if (pendingInit !== null && pendingInit.retries < FOCUS_RETRY) {
      pendingFocusRef.current = null;
      selectAndScroll(pendingInit.id);
    }
    return () => {
      mind.bus.removeListener("selectNodes", onSelect);
      mind.bus.removeListener("expandNode", onExpand);
      mind.destroy();
      mindRef.current = null;
      appliedDataRef.current = null;
    };
  }, [fitToCanvas, ready, selectAndScroll]);

  // 数据变化 → refresh()（保留实例；折叠态由投影数据恢复，避免破坏级重建）。
  useEffect(() => {
    const mind = mindRef.current;
    if (mind === null || !ready || data === appliedDataRef.current) return;
    appliedDataRef.current = data;
    mind.refresh(data);
    if (fitModeRef.current === "fit") fitToCanvas();
    // 等待展开的分支已就位 → 执行延迟聚焦。
    const pending = pendingFocusRef.current;
    if (pending !== null && pending.retries < FOCUS_RETRY) {
      pendingFocusRef.current = null;
      selectAndScroll(pending.id);
    }
  }, [data, fitToCanvas, ready, selectAndScroll]);

  // 外部聚焦（列表/关系图/中栏触发）→ 先展开收起的分支，再选中并滚动定位。
  useEffect(() => {
    if (focusConceptId === null || focusConceptId === "") return;
    // 导图自身点击引起的 focus 回流：节点已选中，直接跳过重复定位。
    if (focusConceptId === selfSelectedRef.current) return;
    if (openAncestorsIfNeeded(focusConceptId)) {
      pendingFocusRef.current = { id: focusConceptId, retries: 0 };
      return;
    }
    selectAndScroll(focusConceptId);
  }, [focusConceptId, openAncestorsIfNeeded, selectAndScroll]);

  const setZoom = useCallback((factor: number) => {
    const mind = mindRef.current;
    if (mind === null) return;
    const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, mind.scaleVal * factor));
    mind.scale(next);
    setFitMode("1:1");
  }, []);

  const applyFitMode = useCallback(
    (mode: "fit" | "1:1") => {
      const mind = mindRef.current;
      setFitMode(mode);
      if (mind === null) return;
      if (mode === "1:1") {
        mind.scale(1);
        mind.toCenter();
      } else {
        fitToCanvas();
      }
    },
    [fitToCanvas],
  );

  const toggleExpandAll = useCallback(
    (expand: boolean) => {
      for (const chapter of syllabus.chapters) {
        const shouldCollapse = !expand;
        if ((collapsed[chapter.id] ?? false) !== shouldCollapse) {
          onToggleRef.current(chapter.id, shouldCollapse);
        }
      }
    },
    [collapsed, syllabus.chapters],
  );

  const exportImage = useCallback(async () => {
    const el = containerRef.current;
    if (el === null || exporting) return;
    const canvas = el.querySelector<HTMLElement>(".map-canvas") ?? el;
    setExporting(true);
    try {
      const dataUrl = await toPng(canvas, { backgroundColor: "#ffffff" });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${(syllabus.title || "syllabus").replace(/[^\w\u4e00-\u9fa5-]+/g, "-")}-mindmap.png`;
      link.click();
    } catch (exc) {
      console.error("导出思维导图失败：", exc);
    } finally {
      setExporting(false);
    }
  }, [exporting, syllabus.title]);

  return (
    <div className="relative h-[clamp(320px,62vh,640px)] w-full overflow-hidden rounded-lg border border-border-line bg-bg-root/60">
      <div ref={containerRef} className="studyclaw-mindmap h-full w-full" data-testid="syllabus-mindmap" />
      {error ? (
        <p className="absolute inset-0 flex items-center justify-center text-[11px] text-accent-fail">思维导图初始化失败：{error}</p>
      ) : null}
      {ready && error === null ? (
        <div className="sc-mm-toolbar absolute right-1.5 top-1.5 flex max-w-[calc(100%-12px)] gap-1 rounded-lg border border-border-line bg-bg-panel/95 p-1 shadow-[0_1px_2px_rgba(15,17,21,0.05)]">
          <button
            type="button"
            title="适配视图"
            aria-label="适配视图"
            aria-pressed={fitMode === "fit"}
            onClick={() => applyFitMode("fit")}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
              fitMode === "fit" ? "bg-bg-card text-accent-focus" : "text-text-muted hover:bg-bg-card hover:text-text-primary"
            }`}
          >
            <Focus size={13} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            type="button"
            title="1:1 原尺寸"
            aria-label="1:1 原尺寸"
            aria-pressed={fitMode === "1:1"}
            onClick={() => applyFitMode("1:1")}
            className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-[10px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
              fitMode === "1:1" ? "bg-bg-card text-accent-focus" : "text-text-muted hover:bg-bg-card hover:text-text-primary"
            }`}
          >
            1:1
          </button>
          <button
            type="button"
            title="放大"
            aria-label="放大"
            onClick={() => setZoom(1.25)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <ZoomIn size={13} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            type="button"
            title="缩小"
            aria-label="缩小"
            onClick={() => setZoom(1 / 1.25)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <ZoomOut size={13} strokeWidth={1.8} aria-hidden />
          </button>
          <span className="mx-0.5 w-px self-center bg-border-line" aria-hidden />
          <button
            type="button"
            title="全部展开"
            aria-label="全部展开"
            onClick={() => toggleExpandAll(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <UnfoldVertical size={13} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            type="button"
            title="全部收起"
            aria-label="全部收起"
            onClick={() => toggleExpandAll(false)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <FoldVertical size={13} strokeWidth={1.8} aria-hidden />
          </button>
          <span className="mx-0.5 w-px self-center bg-border-line" aria-hidden />
          <button
            type="button"
            title="导出 PNG"
            aria-label="导出 PNG"
            disabled={exporting}
            onClick={() => void exportImage()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <Download size={13} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
