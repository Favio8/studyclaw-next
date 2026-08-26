import { describe, expect, it } from "vitest";
import { buildPrereqNames, conceptHtml, projectToMindmap } from "../src/lib/syllabusMindmapData";
import type { Syllabus } from "../src/types";

const syllabus: Syllabus = {
  courseId: "course-1",
  title: "Kubernetes 基础",
  version: "1.0",
  granularity: "fine",
  chapters: [
    {
      id: "chapter-1",
      title: "第一章",
      description: "",
      dependencies: [],
      concepts: [
        { id: "concept-1", name: "调度", type: "mechanism", prerequisites: [], masteryScore: 0 },
        { id: "concept-2", name: "网络策略", type: "mechanism", prerequisites: ["concept-1"], masteryScore: 0 },
      ],
    },
    {
      id: "chapter-2",
      title: "第二章",
      description: "",
      dependencies: [],
      concepts: [{ id: "concept-3", name: "存储卷", type: "mechanism", prerequisites: [], masteryScore: 0 }],
    },
  ],
};

describe("projectToMindmap", () => {
  it("projects chapters as branches and concepts as leaves with metadata", () => {
    const data = projectToMindmap(syllabus, { "concept-1": { status: "mastered", mastery: 0.8 } }, buildPrereqNames(syllabus));
    const chapters = data.nodeData.children!;
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.topic).toBe("第一章");
    const leaves = chapters[0]!.children ?? [];
    expect(leaves).toHaveLength(2);
    expect(leaves[0]!.metadata).toMatchObject({
      conceptId: "concept-1",
      status: "mastered",
      mastery: 0.8,
      prereqCount: 0,
      prereqNames: [],
    });
    expect(leaves[1]!.metadata).toMatchObject({
      conceptId: "concept-2",
      prereqCount: 1,
      prereqNames: ["调度"],
    });
  });

  it("falls back to locked status when mastery is missing", () => {
    const data = projectToMindmap(syllabus, {}, buildPrereqNames(syllabus));
    const leaf = data.nodeData.children![0]!.children![0]!;
    expect(leaf.metadata!.status).toBe("locked");
    expect(leaf.metadata!.mastery).toBe(0);
  });

  it("marks collapsed chapters via options.collapsed", () => {
    const data = projectToMindmap(syllabus, {}, buildPrereqNames(syllabus), { collapsed: { "chapter-1": true } });
    const chapters = data.nodeData.children!;
    expect(chapters[0]!.expanded).toBe(false);
    expect(chapters[1]!.expanded).toBeUndefined();
  });

  it("dims concepts that do not match a non-empty searchQuery", () => {
    const data = projectToMindmap(syllabus, {}, buildPrereqNames(syllabus), { searchQuery: "网络策略" });
    const leaves = data.nodeData.children![0]!.children!;
    expect(leaves[0]!.metadata!.dim).toBe(true);
    expect(leaves[1]!.metadata!.dim).toBe(false);
    // 章节名命中 → 整章不 dim。
    const chapterHit = projectToMindmap(syllabus, {}, buildPrereqNames(syllabus), { searchQuery: "第二章" });
    expect(chapterHit.nodeData.children![1]!.children![0]!.metadata!.dim).toBe(false);
  });
});

describe("conceptHtml", () => {
  it("renders a dependency badge with tooltip only when prereqs exist", () => {
    const withDeps = conceptHtml("网络策略", { conceptId: "c", status: "learning", mastery: 0.5, prereqCount: 1, prereqNames: ["调度"] });
    expect(withDeps).toContain("1 依赖");
    expect(withDeps).toContain("先修：调度");
    const noDeps = conceptHtml("调度", { conceptId: "c", status: "mastered", mastery: 0.9, prereqCount: 0, prereqNames: [] });
    expect(noDeps).not.toContain("依赖");
  });

  it("emits semantic classes/data-status and no inline styles or hardcoded colors", () => {
    const withDeps = conceptHtml("网络策略", { conceptId: "c", status: "learning", mastery: 0.5, prereqCount: 1, prereqNames: ["调度"] });
    expect(withDeps).toContain('class="sc-mm-node"');
    expect(withDeps).toContain('data-status="learning"');
    expect(withDeps).toContain("sc-mm-dot");
    expect(withDeps).toContain("sc-mm-badge");
    expect(withDeps).toContain("sc-mm-pct");
    expect(withDeps).not.toMatch(/style=/);
    expect(withDeps).not.toMatch(/font-size|#[0-9a-fA-F]{6}/);
    expect(withDeps).not.toContain("F1F3F5");
  });

  it("adds the dim class for non-matching concepts", () => {
    const dimmed = conceptHtml("调度", { conceptId: "c", status: "locked", mastery: 0, prereqCount: 0, prereqNames: [], dim: true });
    expect(dimmed).toContain("sc-mm-dim");
  });
});
