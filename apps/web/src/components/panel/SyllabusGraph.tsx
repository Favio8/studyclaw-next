"use client";

/**
 * 大纲「关系图视图」（T3.4，ui_design_spec §4.2）：React Flow DAG，
 * dagre 自动分层布局（rankdir=LR，先修在左、后继在右）。
 *
 * - 节点 = 概念，按章节色板着色（色点 + 图例点击高亮该章概念）；
 * - 节点填充/边框 = 掌握度状态色（mastered/pass、learning/warn、
 *   weak/fail、locked 灰化 + 🔒）；
 * - 边 = prerequisites 依赖方向（smoothstep 折线 + 箭头）；
 * - 节点可拖拽微调，「重新布局」一键复位（dagre 坐标 + fitView）；
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
import { Download, Lock, RefreshCw } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { Syllabus } from "@/src/types";

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

const NODE_STYLE: Record<string, { border: string; bg: string }> = {
  mastered: { border: "var(--color-accent-pass)", bg: "color-mix(in srgb, var(--color-accent-pass) 10%, var(--color-bg-panel))" },
  learning: { border: "var(--color-accent-warn)", bg: "color-mix(in srgb, var(--color-accent-warn) 10%, var(--color-bg-panel))" },
  weak: { border: "var(--color-accent-fail)", bg: "color-mix(in srgb, var(--color-accent-fail) 8%, var(--color-bg-panel))" },
  locked: { border: "var(--color-border-strong)", bg: "var(--color-bg-card)" },
};

interface ConceptNodeData {
  label: string;
  status: string;
  chapterColor: string;
  chapterTitle: string;
  dim?: boolean;
}

function ConceptNode({ data }: NodeProps) {
  const { label, status, chapterColor, chapterTitle, dim } = data as unknown as ConceptNodeData;
  const style = NODE_STYLE[status] ?? NODE_STYLE.locked;
  const locked = status === "locked";
  return (
    <div
      title={`${chapterTitle} · ${label}`}
      className="flex h-[30px] w-[128px] items-center gap-1.5 rounded-md border bg-bg-panel px-2 text-[11px] text-text-primary shadow-[0_1px_2px_rgba(15,17,21,0.05)] transition-opacity"
      style={{ borderColor: style.border, backgroundColor: style.bg, opacity: dim ? 0.3 : 1 }}
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
  onFocusConcept: (conceptId: string, name: string) => void;
}

export default function SyllabusGraph({ syllabus, statusMap, onFocusConcept }: SyllabusGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner syllabus={syllabus} statusMap={statusMap} onFocusConcept={onFocusConcept} />
    </ReactFlowProvider>
  );
}

interface GraphNodeData extends ConceptNodeData {
  chapterIdx: number;
}

function GraphInner({ syllabus, statusMap, onFocusConcept }: SyllabusGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { fitView } = useReactFlow();
  const [activeChapter, setActiveChapter] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const { nodes: rawNodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const meta: Record<string, { chapterIdx: number; chapterTitle: string; chapterColor: string }> = {};
    syllabus.chapters.forEach((chapter, idx) => {
      const color = CHAPTER_COLORS[idx % CHAPTER_COLORS.length];
      chapter.concepts.forEach((concept) => {
        meta[concept.id] = { chapterIdx: idx, chapterTitle: chapter.title, chapterColor: color };
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
          } satisfies GraphNodeData,
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
    return { nodes, edges };
  }, [syllabus, statusMap]);

  const applyDim = useCallback((nodes: Node[], active: number | null): Node[] => {
    if (active === null) return nodes;
    return nodes.map((node) => {
      const data = node.data as unknown as GraphNodeData | undefined;
      if (data?.chapterIdx === undefined) return node;
      return { ...node, data: { ...data, dim: data.chapterIdx !== active } };
    });
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(rawNodes);

  useEffect(() => {
    setNodes(layoutConceptDag(rawNodes, edges));
    // mount 时的 fitView 跑在未布局坐标上；dagre 布局完成后重新归位。
    // maxZoom 1：无依赖边时内容很薄，防止 fitView 把节点放大到数倍。
    void fitView({ padding: 0.15, maxZoom: 1 });
  }, [edges, fitView, rawNodes, setNodes]);

  useEffect(() => {
    setNodes((current) => applyDim(current, activeChapter));
  }, [activeChapter, applyDim, setNodes]);

  const relayout = useCallback(() => {
    setNodes(layoutConceptDag(rawNodes, edges));
    void fitView({ padding: 0.15, maxZoom: 1, duration: 300 });
  }, [edges, fitView, rawNodes, setNodes]);

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

  const totalConcepts = syllabus.chapters.reduce((sum, chapter) => sum + chapter.concepts.length, 0);
  const height = Math.min(560, Math.max(320, 300 + totalConcepts * 10));

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-lg border border-border-line bg-bg-root/60"
      style={{ height: `${height}px` }}
      data-testid="syllabus-graph-viewport"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("chap:")) return;
          const data = node.data as unknown as ConceptNodeData | undefined;
          onFocusConcept(node.id, data?.label ?? node.id);
        }}
      >
        <Background color="var(--color-border-faint)" gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => String((node.data as unknown as GraphNodeData | undefined)?.chapterColor ?? "var(--color-border-strong)")}
          maskColor="rgba(249,250,251,0.75)"
          className="!h-24 !w-24"
        />
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
        <Panel position="bottom-left" className="!m-1.5">
          <div className="flex max-w-[220px] flex-wrap gap-1 rounded-md border border-border-line bg-bg-panel/95 p-1 shadow-[0_1px_2px_rgba(15,17,21,0.05)]">
            {syllabus.chapters.map((chapter, idx) => {
              const active = activeChapter === idx;
              return (
                <button
                  key={chapter.id}
                  type="button"
                  title={`高亮章节：${chapter.title}`}
                  aria-pressed={active}
                  onClick={() => setActiveChapter((prev) => (prev === idx ? null : idx))}
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
        </Panel>
      </ReactFlow>
    </div>
  );
}
