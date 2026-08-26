"use client";

/**
 * 大纲「关系图视图」（T3.4，ui_design_spec §4.2；P3 迭代）：React Flow DAG，
 * dagre 自动分层布局（rankdir=LR，先修在左、后继在右）。
 *
 * - 节点 = 概念，按章节色板着色（色点 + 图例点击高亮该章概念）；
 * - 节点填充/边框 = 掌握度状态色（mastered/pass、learning/warn、
 *   weak/fail、locked 灰化 + 🔒），左上角状态图例含颜色含义；
 * - 边 = prerequisites 依赖方向（smoothstep 折线 + 箭头）；
 * - 节点可拖拽微调，「重新布局」一键复位（dagre 坐标 + fitView）；
 * - 外部聚焦（focusConceptId）→ 节点描边高亮 + 双击该节点放大定位；
 * - 搜索词（searchQuery）非空 → 未命中概念弱化；
 * - MiniMap 辅助导航；「导出 PNG」用 html-to-image 截取视图。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { toPng } from "html-to-image";
import { Download, Lock, RefreshCw, X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { Syllabus } from "@/src/types";
import { buildPrereqNames } from "@/src/lib/syllabusMindmapData";

export interface ConceptStatus {
  status: "locked" | "learning" | "weak" | "mastered";
  mastery: number;
}

/** 概念节点固定渲染尺寸（与 dagre 布局输入一致，避免重叠）。 */
export const CONCEPT_W = 128;
export const CONCEPT_H = 30;

/** 章节色板（≤8 色循环；先修依赖图里用色 + 图例表达章节归属）。 */
export const CHAPTER_COLORS = [
  "#4176e6", // brand blue
  "#059669", // pass green
  "#d97706", // amber
  "#dc2626", // fail red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // olive
] as const;

/** 掌握度状态 → 节点视觉（border/bg 用设计 token，勿写死色值）。 */
const NODE_STYLE: Record<string, { border: string; bg: string; label: string }> = {
  mastered: { border: "var(--color-accent-pass)", bg: "color-mix(in srgb, var(--color-accent-pass) 10%, var(--color-bg-panel))", label: "已掌握" },
  learning: { border: "var(--color-accent-warn)", bg: "color-mix(in srgb, var(--color-accent-warn) 10%, var(--color-bg-panel))", label: "学习中" },
  weak: { border: "var(--color-accent-fail)", bg: "color-mix(in srgb, var(--color-accent-fail) 8%, var(--color-bg-panel))", label: "薄弱" },
  locked: { border: "var(--color-border-strong)", bg: "var(--color-bg-card)", label: "未开启" },
};

export const STATUS_KEYS = Object.keys(NODE_STYLE);

interface ConceptNodeData {
  label: string;
  status: string;
  chapterColor: string;
  chapterTitle: string;
  chapterIdx: number;
  type: string;
  dim?: boolean;
  focused?: boolean;
}

function ConceptNode({ data }: NodeProps) {
  const { label, status, chapterColor, chapterTitle, type, dim, focused } = data as unknown as ConceptNodeData;
  const style = NODE_STYLE[status] ?? NODE_STYLE.locked;
  const locked = status === "locked";
  return (
    <div
      title={`${chapterTitle} · ${label}（${NODE_STYLE[status]?.label ?? type}）`}
      className={`flex h-[30px] w-[128px] items-center gap-1.5 rounded-md border bg-bg-panel px-2 text-[11px] text-text-primary shadow-[0_1px_2px_rgba(15,17,21,0.05)] transition-opacity ${
        focused ? "ring-2 ring-accent-focus ring-offset-1 ring-offset-bg-panel" : ""
      }`}
      style={{ borderColor: style.border, backgroundColor: style.bg, opacity: dim ? 0.3 : 1 }}
      data-testid="concept-node"
      data-focused={focused ? "true" : undefined}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: chapterColor }} aria-hidden />
      <span className="truncate">{label}</span>
      {locked && <Lock size={11} strokeWidth={1.8} className="shrink-0 text-text-faint" aria-label="已锁定" />}
    </div>
  );
}

const nodeTypes = { concept: ConceptNode };

/**
 * dagre 分层布局：输入（概念）nodes/edges，输出带 position 的 nodes。
 * 导出为纯函数便于单测。边缺失/悬空的节点作为孤立节点由 dagre 排布。
 */
export function layoutConceptDag(nodes: Node[], edges: Edge[]): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", ranksep: 70, nodesep: 28, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width ?? CONCEPT_W, height: node.height ?? CONCEPT_H });
  }
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  return nodes.map((node) => {
    const pos = graph.node(node.id);
    return {
      ...node,
      position: {
        x: (pos?.x ?? 0) - CONCEPT_W / 2,
        y: (pos?.y ?? 0) - CONCEPT_H / 2,
      },
    };
  });
}

interface SyllabusGraphProps {
  syllabus: Syllabus;
  statusMap: Record<string, ConceptStatus>;
  searchQuery?: string;
  focusConceptId?: string | null;
  onFocusConcept: (conceptId: string, name: string) => void;
}

export default function SyllabusGraph({ syllabus, statusMap, searchQuery = "", focusConceptId = null, onFocusConcept }: SyllabusGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner syllabus={syllabus} statusMap={statusMap} searchQuery={searchQuery} focusConceptId={focusConceptId} onFocusConcept={onFocusConcept} />
    </ReactFlowProvider>
  );
}

interface GraphDetail {
  id: string;
  label: string;
  status: string;
  mastery: number;
  type: string;
  chapterTitle: string;
  prereqs: string[];
  dependents: string[];
}

function GraphInner({ syllabus, statusMap, searchQuery = "", focusConceptId = null, onFocusConcept }: SyllabusGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { fitView } = useReactFlow();
  const [activeChapter, setActiveChapter] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState<GraphDetail | null>(null);

  const { nodes: rawNodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const meta: Record<string, { chapterIdx: number; chapterTitle: string; chapterColor: string; type: string }> = {};
    syllabus.chapters.forEach((chapter, idx) => {
      const color = CHAPTER_COLORS[idx % CHAPTER_COLORS.length];
      chapter.concepts.forEach((concept) => {
        meta[concept.id] = { chapterIdx: idx, chapterTitle: chapter.title, chapterColor: color, type: concept.type };
        nodes.push({
          id: concept.id,
          type: "concept",
          position: { x: 0, y: 0 },
          width: CONCEPT_W,
          height: CONCEPT_H,
          data: {
            label: concept.name,
            status: statusMap[concept.id]?.status ?? "locked",
            chapterColor: color,
            chapterTitle: chapter.title,
            chapterIdx: idx,
            type: concept.type,
          } satisfies ConceptNodeData,
        });
      });
    });
    syllabus.chapters.forEach((chapter) => {
      chapter.concepts.forEach((concept) => {
        concept.prerequisites.forEach((prereq) => {
          if (!meta[prereq] || !meta[concept.id]) return; // 悬空依赖跳过
          edges.push({
            id: `${prereq}->${concept.id}`,
            source: prereq,
            target: concept.id,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-text-faint)" },
            style: { stroke: "var(--color-border-strong)", strokeWidth: 1.2 },
          });
        });
      });
    });
    return { nodes, edges, meta };
  }, [syllabus, statusMap]);

  // 初始节点即为布局后坐标（消除首帧「全部叠在左上角」闪跳）。
  const laidOut = useMemo(() => layoutConceptDag(rawNodes, edges), [edges, rawNodes]);
  const [nodes, setNodes, onNodesChange] = useNodesState(laidOut);

  // 数据变化（粒度/状态/章节）→ 重新布局。
  useEffect(() => {
    setNodes(laidOut);
  }, [laidOut, setNodes]);

  const prereqNames = useMemo(() => buildPrereqNames(syllabus), [syllabus]);
  const successors = useMemo(() => {
    const byId = new Map<string, string[]>();
    syllabus.chapters.forEach((chapter) =>
      chapter.concepts.forEach((concept) => {
        concept.prerequisites.forEach((prereq) => {
          const list = byId.get(prereq) ?? [];
          if (!list.includes(concept.name)) list.push(concept.name);
          byId.set(prereq, list);
        });
      }),
    );
    return byId;
  }, [syllabus]);

  const searchHit = useMemo(() => {
    if (searchQuery === "") return null;
    const set = new Set<string>();
    syllabus.chapters.forEach((chapter) => {
      chapter.concepts.forEach((concept) => {
        if (concept.name.toLowerCase().includes(searchQuery) || chapter.title.toLowerCase().includes(searchQuery)) {
          set.add(concept.id);
        }
      });
    });
    return set;
  }, [searchQuery, syllabus]);

  // 视图态（章节过滤 / 搜索命中 / 外部聚焦）→ 只改 data / style，不动坐标。
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const data = node.data as unknown as ConceptNodeData | undefined;
        if (data?.chapterIdx === undefined) return node;
        const dim =
          (activeChapter !== null && data.chapterIdx !== activeChapter) ||
          (searchHit !== null && !searchHit.has(node.id));
        const focused = focusConceptId === node.id;
        if (data.dim === dim && data.focused === focused) return node;
        return { ...node, data: { ...data, dim, focused } };
      }),
    );
  }, [activeChapter, focusConceptId, searchHit, setNodes]);

  const fitViewNow = useCallback(
    (opts?: { nodes?: Node[]; duration?: number }) => {
      if (opts?.nodes) {
        void fitView({ nodes: opts.nodes, padding: 0.8, maxZoom: 1, duration: opts.duration ?? 300 });
      } else {
        void fitView({ padding: 0.15, minZoom: 0.35, maxZoom: 1, duration: opts?.duration ?? 300 });
      }
    },
    [fitView],
  );

  // 布局完成后归位（首次与每次重布局后）。
  useEffect(() => {
    fitViewNow({ duration: 300 });
  }, [fitViewNow, laidOut]);

  const relayout = useCallback(() => {
    setNodes(laidOut);
    void fitViewNow({ duration: 300 });
  }, [fitViewNow, laidOut, setNodes]);

  const exportImage = useCallback(async () => {
    const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport || exporting) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(viewport, {
        backgroundColor: "#ffffff",
        filter: (element) => !(element.classList?.contains("react-flow__minimap")
          || element.classList?.contains("react-flow__controls")
          || element.classList?.contains("react-flow__panel")),
      });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${(syllabus.title || "syllabus").replace(/[^\w\u4e00-\u9fa5-]+/g, "-")}-graph.png`;
      link.click();
    } catch (error) {
      console.error("导出关系图失败：", error);
    } finally {
      setExporting(false);
    }
  }, [exporting, syllabus.title]);

  const toggleChapter = useCallback((idx: number) => {
    setActiveChapter((prev) => (prev === idx ? null : idx));
    setDetail(null);
  }, []);

  const showDetail = useCallback(
    (node: Node) => {
      const data = node.data as unknown as ConceptNodeData | undefined;
      if (data === undefined) return;
      const st = statusMap[node.id];
      setDetail({
        id: node.id,
        label: data.label,
        status: st?.status ?? "locked",
        mastery: st?.mastery ?? 0,
        type: data.type,
        chapterTitle: data.chapterTitle,
        prereqs: prereqNames[node.id] ?? [],
        dependents: successors.get(node.id) ?? [],
      });
    },
    [prereqNames, statusMap, successors],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[clamp(320px,62vh,640px)] w-full overflow-hidden rounded-lg border border-border-line bg-bg-root/60"
      data-testid="syllabus-graph-viewport"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: 0.35, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          onFocusConcept(node.id, (node.data as unknown as ConceptNodeData | undefined)?.label ?? node.id);
          showDetail(node);
        }}
        onNodeDoubleClick={(_, node) => fitViewNow({ nodes: [node] })}
        onPaneClick={() => setDetail(null)}
      >
        <Background color="var(--color-border-faint)" gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => String((node.data as unknown as ConceptNodeData | undefined)?.chapterColor ?? "var(--color-border-strong)")}
          maskColor="rgba(249,250,251,0.75)"
          className="!h-24 !w-24"
        />
        {/* 掌握度状态图例 + 章节过滤图例（左上，两行） */}
        <Panel position="top-left" className="!m-1.5">
          <div className="flex max-w-[250px] flex-col gap-1.5">
            <div className="flex flex-wrap gap-1 rounded-md border border-border-line bg-bg-panel/95 p-1 shadow-[0_1px_2px_rgba(15,17,21,0.05)]">
              {STATUS_KEYS.map((key) => {
                const st = NODE_STYLE[key]!;
                return (
                  <span key={key} className="flex min-h-5 items-center gap-1 rounded px-1.5 text-[10px] text-text-muted">
                    <span className="h-2.5 w-4 shrink-0 rounded-sm border" style={{ backgroundColor: st.bg, borderColor: st.border }} aria-hidden />
                    <span>{st.label}</span>
                  </span>
                );
              })}
            </div>
            <div className="flex max-w-[250px] flex-wrap gap-1 rounded-md border border-border-line bg-bg-panel/95 p-1 shadow-[0_1px_2px_rgba(15,17,21,0.05)]">
              {syllabus.chapters.map((chapter, idx) => {
                const active = activeChapter === idx;
                return (
                  <button
                    key={chapter.id}
                    type="button"
                    title={`高亮章节：${chapter.title}`}
                    aria-pressed={active}
                    onClick={() => toggleChapter(idx)}
                    className={`flex min-h-5 items-center gap-1 rounded px-1.5 text-[10px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
                      active ? "bg-bg-card text-text-primary" : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: CHAPTER_COLORS[idx % CHAPTER_COLORS.length] }} aria-hidden />
                    <span className="max-w-[72px] truncate">{chapter.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Panel>
        {/* 工具（右上） */}
        <Panel position="top-right" className="!m-1.5">
          <div className="flex gap-1">
            <button
              type="button"
              title="重新布局"
              aria-label="重新布局"
              onClick={relayout}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border-line bg-bg-panel text-text-muted shadow-[0_1px_2px_rgba(15,17,21,0.05)] transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            >
              <RefreshCw size={13} strokeWidth={1.8} aria-hidden />
            </button>
            <button
              type="button"
              title="导出 PNG"
              aria-label="导出 PNG"
              disabled={exporting}
              onClick={() => void exportImage()}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border-line bg-bg-panel text-text-muted shadow-[0_1px_2px_rgba(15,17,21,0.05)] transition-colors hover:text-text-primary disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            >
              <Download size={13} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </Panel>
      </ReactFlow>
      {detail ? (
        <div className="absolute right-2 top-10 z-20 w-[260px] rounded-lg border border-border-line bg-bg-panel p-3 shadow-lv2" role="dialog" aria-label={`${detail.label} 详情`}>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-[13px] font-medium text-text-primary">{detail.label}</p>
            <button
              type="button"
              aria-label="关闭详情"
              onClick={() => setDetail(null)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            >
              <X size={12} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
          <p className="mt-0.5 text-[10px] text-text-faint">{detail.chapterTitle} · {detail.type}</p>
          <div className="mt-2 space-y-1 text-[11px] leading-5 text-text-muted">
            <p><span className="inline-block w-12 text-text-faint">状态</span><span className="text-text-primary">{NODE_STYLE[detail.status]?.label}</span>
              <span className="ml-1.5 tabular-nums text-text-faint">{Math.round(detail.mastery * 100)}%</span>
            </p>
            <p className="min-w-0 break-words"><span className="inline-block w-12 text-text-faint">先修</span><span className="text-text-primary">{detail.prereqs.length > 0 ? detail.prereqs.join("、") : "无"}</span></p>
            <p className="min-w-0 break-words"><span className="inline-block w-12 text-text-faint">后继</span><span className="text-text-primary">{detail.dependents.length > 0 ? detail.dependents.join("、") : "无"}</span></p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
