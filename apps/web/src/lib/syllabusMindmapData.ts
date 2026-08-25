/**
 * 思维导图数据投影（纯函数，无 DOM/mind-elixir 依赖，便于单测）：
 * 课程根 → 章节分支（章节色板）→ 概念叶子（掌握度/先修角标）。
 */

import type { Syllabus } from "@/src/types";
import type { ConceptStatus } from "@/src/components/panel/SyllabusGraph";
import { CHAPTER_COLORS } from "@/src/components/panel/SyllabusGraph";

export interface MindmapConceptMeta {
  conceptId: string;
  status: ConceptStatus["status"];
  mastery: number;
  prereqCount: number;
  prereqNames: string[];
}

export interface MindmapNode {
  topic: string;
  id: string;
  branchColor?: string;
  children?: MindmapNode[];
  dangerouslySetInnerHTML?: string;
  metadata?: MindmapConceptMeta;
}

export interface MindmapData {
  nodeData: MindmapNode;
  direction: number;
}

export const STATUS_COLOR: Record<string, string> = {
  mastered: "#059669",
  learning: "#d97706",
  weak: "#dc2626",
  locked: "#9ca3af",
};

function escHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 概念节点自定义 HTML：状态色点 + 名称 + 依赖角标 + 掌握度。 */
export function conceptHtml(name: string, meta: MindmapConceptMeta): string {
  const color = STATUS_COLOR[meta.status] ?? STATUS_COLOR.locked;
  const dot = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};flex:0 0 auto"></span>`;
  const badge = meta.prereqCount > 0
    ? `<span title="${escHtml(`先修：${meta.prereqNames.join("、")}`)}" style="flex:0 0 auto;font-size:9px;line-height:12px;padding:0 4px;border-radius:6px;background:#F1F3F5;color:#81858C">${meta.prereqCount} 依赖</span>`
    : "";
  const pct = `<span style="flex:0 0 auto;font-size:9px;color:#81858C">${Math.round(meta.mastery * 100)}%</span>`;
  return `<div style="display:flex;align-items:center;gap:4px;max-width:180px;white-space:nowrap;overflow:hidden">${dot}${badge}<span style="overflow:hidden;text-overflow:ellipsis">${escHtml(name)}</span>${pct}</div>`;
}

/**
 * 数据投影：课程根 → 章节分支 → 概念叶子。conceptId 挂在 metadata
 * 上（点击回调与聚焦定位用），先修名列表用于角标 tooltip。
 */
export function projectToMindmap(
  syllabus: Syllabus,
  statusMap: Record<string, ConceptStatus>,
  prereqNames: Record<string, string[]>,
  direction = 2, // MindElixir.SIDE
): MindmapData {
  const root: MindmapNode = { topic: syllabus.title, id: "root" };
  root.children = syllabus.chapters.map((chapter, idx) => {
    const chapterNode: MindmapNode = {
      topic: chapter.title,
      id: `chap:${chapter.id}`,
      branchColor: CHAPTER_COLORS[idx % CHAPTER_COLORS.length],
      children: chapter.concepts.map((concept) => {
        const st = statusMap[concept.id];
        const meta: MindmapConceptMeta = {
          conceptId: concept.id,
          status: st?.status ?? "locked",
          mastery: st?.mastery ?? 0,
          prereqCount: concept.prerequisites.length,
          prereqNames: prereqNames[concept.id] ?? [],
        };
        return {
          topic: concept.name,
          id: concept.id,
          dangerouslySetInnerHTML: conceptHtml(concept.name, meta),
          metadata: meta,
        };
      }),
    };
    return chapterNode;
  });
  return { nodeData: root, direction };
}

/** 概念 id → 先修概念名列表（角标 tooltip 用）。 */
export function buildPrereqNames(syllabus: Syllabus): Record<string, string[]> {
  const byId = new Map<string, string>();
  syllabus.chapters.forEach((chapter) => chapter.concepts.forEach((concept) => byId.set(concept.id, concept.name)));
  const out: Record<string, string[]> = {};
  syllabus.chapters.forEach((chapter) => {
    chapter.concepts.forEach((concept) => {
      out[concept.id] = concept.prerequisites
        .map((id) => byId.get(id))
        .filter((name): name is string => name !== undefined);
    });
  });
  return out;
}
