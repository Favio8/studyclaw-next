"use client";

/**
 * 大纲「思维导图视图」（阶段二，B1 mind-elixir）：章节 = 一级分支、
 * 概念 = 子节点；掌握度状态色点 + 百分比 + 「N 依赖」角标（tooltip
 * 列先修概念名）。只读展示（editable=false），保留折叠/展开；
 * 节点点击 → onFocusConcept（切回列表聚焦 + 中栏注入）。
 *
 * 由 SyllabusTab 经 next/dynamic({ ssr: false }) 惰性加载。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import MindElixir from "mind-elixir";
import type { MindElixirData, NodeObj } from "mind-elixir";
import "mind-elixir/style.css";
import type { Syllabus } from "@/src/types";
import type { ConceptStatus } from "@/src/components/panel/SyllabusGraph";
import { buildPrereqNames, projectToMindmap, type MindmapConceptMeta } from "@/src/lib/syllabusMindmapData";
import { CHAPTER_COLORS } from "@/src/components/panel/SyllabusGraph";

export { buildPrereqNames, projectToMindmap, type MindmapConceptMeta };

const MINIMAP_THEME = {
  name: "studyclaw",
  type: "light" as const,
  palette: [...CHAPTER_COLORS],
  cssVar: {
    "--main-color": "var(--color-text-primary)",
    "--main-bgcolor": "var(--color-bg-panel)",
    "--color": "var(--color-text-primary)",
    "--bgcolor": "var(--color-bg-card)",
    "--selected": "var(--color-accent-focus)",
    "--accent-color": "var(--color-accent-focus)",
    "--root-color": "#ffffff",
    "--root-bgcolor": "var(--color-accent-focus)",
    "--root-border-color": "var(--color-accent-focus)",
    "--root-radius": "8px",
    "--main-radius": "6px",
    "--panel-color": "var(--color-text-muted)",
    "--panel-bgcolor": "var(--color-bg-panel)",
    "--panel-border-color": "var(--color-border-line)",
    "--map-padding": "12px",
  },
};

interface SyllabusMindmapProps {
  syllabus: Syllabus;
  statusMap: Record<string, ConceptStatus>;
  onFocusConcept: (conceptId: string, name: string) => void;
}

export default function SyllabusMindmap({ syllabus, statusMap, onFocusConcept }: SyllabusMindmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prereqNames = useMemo(() => buildPrereqNames(syllabus), [syllabus]);
  const data: MindElixirData = useMemo(
    () => projectToMindmap(syllabus, statusMap, prereqNames) as MindElixirData,
    [prereqNames, statusMap, syllabus],
  );

  const totalConcepts = syllabus.chapters.reduce((sum, chapter) => sum + chapter.concepts.length, 0);
  const height = Math.min(560, Math.max(320, 300 + totalConcepts * 10));

  useEffect(() => {
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
      theme: MINIMAP_THEME,
    });
    const initError = mind.init(data);
    if (initError !== undefined) {
      setError(String(initError));
      return () => mind.destroy();
    }
    // 右栏面板为窄容器：按内容/容器比例缩放归位（否则分支节点横向溢出被裁剪）。
    mind.scaleFit();
    const onSelect = (nodes: NodeObj[]) => {
      const meta = nodes[0]?.metadata as unknown as MindmapConceptMeta | undefined;
      if (meta?.conceptId === undefined || meta.conceptId === "") return;
      onFocusConcept(meta.conceptId, nodes[0]!.topic);
    };
    mind.bus.addListener("selectNodes", onSelect);
    return () => {
      mind.bus.removeListener("selectNodes", onSelect);
      mind.destroy();
    };
  }, [data, onFocusConcept]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border-line bg-bg-root/60" style={{ height: `${height}px` }}>
      <div ref={containerRef} className="h-full w-full" data-testid="syllabus-mindmap" />
      {error ? (
        <p className="absolute inset-0 flex items-center justify-center text-[11px] text-accent-fail">思维导图初始化失败：{error}</p>
      ) : null}
    </div>
  );
}
