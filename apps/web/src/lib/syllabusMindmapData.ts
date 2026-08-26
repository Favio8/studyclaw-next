/**
 * 思维导图数据投影（纯函数，无 DOM/mind-elixir 依赖，便于单测）：
 * 课程根 → 章节分支（章节色板）→ 概念叶子（掌握度/先修角标）。
 *
 * 节点 HTML 只承载语义结构（class + data-status），全部视觉样式
 * 由 `app/globals.css` 中 `.studyclaw-mindmap` 作用域规则提供
 * （设计 token 驱动，禁止内联样式与硬编码色值）。
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
  /** 搜索未命中 → 节点降透明度。 */
  dim?: boolean;
}

export interface MindmapNode {
  topic: string;
  id: string;
  branchColor?: string;
  children?: MindmapNode[];
  dangerouslySetInnerHTML?: string;
  metadata?: MindmapConceptMeta;
  /** 分支折叠状态（chapters 分支用；true=展开，false=收起）。 */
  expanded?: boolean;
}

export interface MindmapData {
  nodeData: MindmapNode;
  direction: number;
}

function escHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 概念节点语义化 HTML：状态点 + 依赖角标 + 名称 + 掌握度（无内联样式）。 */
export function conceptHtml(name: string, meta: MindmapConceptMeta): string {
  const badge = meta.prereqCount > 0
    ? `<span class="sc-mm-badge" title="${escHtml(`先修：${meta.prereqNames.join("、")}`)}">${meta.prereqCount} 依赖</span>`
    : "";
  const pct = `<span class="sc-mm-pct">${Math.round(meta.mastery * 100)}%</span>`;
  const cls = `sc-mm-node${meta.dim ? " sc-mm-dim" : ""}`;
  return `<span class="${cls}" data-status="${meta.status}"><span class="sc-mm-dot"></span>${badge}<span class="sc-mm-text">${escHtml(name)}</span>${pct}</span>`;
}

/**
 * 数据投影：课程根 → 章节分支 → 概念叶子。conceptId 挂在 metadata
 * 上（点击回调与聚焦定位用），先修名列表用于角标 tooltip。
 * `collapsed`（key=章节 id）控制分支折叠；`searchQuery`
 * 非空时未命中概念标记 dim（需配合概念名匹配搜索）。
 */
export function projectToMindmap(
  syllabus: Syllabus,
  statusMap: Record<string, ConceptStatus>,
  prereqNames: Record<string, string[]>,
  options: {
    collapsed?: Record<string, boolean>;
    searchQuery?: string;
    direction?: number;
  } = {},
): MindmapData {
  const { collapsed = {}, direction = 2 /* MindElixir.SIDE */ } = options;
  const search = options.searchQuery?.toLowerCase().trim() ?? "";
  const root: MindmapNode = { topic: syllabus.title, id: "root" };
  root.children = syllabus.chapters.map((chapter, idx) => {
    const chapterKey = `chap:${chapter.id}`;
    const chapterCollapsed = collapsed[chapter.id] === true;
    const chapterHit = search !== "" && chapter.title.toLowerCase().includes(search);
    const chapterNode: MindmapNode = {
      topic: chapter.title,
      id: chapterKey,
      branchColor: CHAPTER_COLORS[idx % CHAPTER_COLORS.length],
      expanded: chapterCollapsed ? false : undefined,
      children: chapter.concepts.map((concept) => {
        const st = statusMap[concept.id];
        const hit = search !== "" && (chapterHit || concept.name.toLowerCase().includes(search));
        const meta: MindmapConceptMeta = {
          conceptId: concept.id,
          status: st?.status ?? "locked",
          mastery: st?.mastery ?? 0,
          prereqCount: concept.prerequisites.length,
          prereqNames: prereqNames[concept.id] ?? [],
          dim: search !== "" && !hit,
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
