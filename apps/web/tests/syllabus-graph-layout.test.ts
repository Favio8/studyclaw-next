import { describe, expect, it } from "vitest";
import { layoutConceptDag, CONCEPT_W, CONCEPT_H } from "../src/components/panel/SyllabusGraph";
import type { Edge, Node } from "@xyflow/react";

/** 生成概念节点（与真实组件一致的固定尺寸）。 */
function conceptNode(id: string): Node {
  return {
    id,
    type: "concept",
    position: { x: 0, y: 0 },
    width: CONCEPT_W,
    height: CONCEPT_H,
    data: { label: id, status: "learning" },
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

describe("layoutConceptDag", () => {
  it("positions all nodes without overlap and keeps an LR direction", () => {
    const nodes = ["a", "b", "c", "d"].map(conceptNode);
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    const laid = layoutConceptDag(nodes, edges);

    expect(laid).toHaveLength(4);
    // 无重叠：任意两节点矩形不相交（含安全余量 1px）。
    for (let i = 0; i < laid.length; i += 1) {
      for (let j = i + 1; j < laid.length; j += 1) {
        const a = laid[i]!.position;
        const b = laid[j]!.position;
        const overlapX = Math.abs(a.x - b.x) < CONCEPT_W;
        const overlapY = Math.abs(a.y - b.y) < CONCEPT_H;
        expect(overlapX && overlapY).toBe(false);
      }
    }
    // LR：先修 a 的 x 严格小于后继 d。
    const pos = (id: string) => laid.find((n) => n.id === id)!.position;
    expect(pos("d").x).toBeGreaterThan(pos("a").x);
  });

  it("handles isolated nodes (no prerequisites) without crashing", () => {
    const nodes = ["a", "b", "c"].map(conceptNode);
    const laid = layoutConceptDag(nodes, []);
    expect(laid).toHaveLength(3);
    for (let i = 0; i < laid.length; i += 1) {
      for (let j = i + 1; j < laid.length; j += 1) {
        const a = laid[i]!.position;
        const b = laid[j]!.position;
        const overlapX = Math.abs(a.x - b.x) < CONCEPT_W;
        const overlapY = Math.abs(a.y - b.y) < CONCEPT_H;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("does not crash on cyclic input and keeps node ids stable", () => {
    const nodes = ["a", "b", "c"].map(conceptNode);
    const laid = layoutConceptDag(nodes, [edge("a", "b"), edge("b", "a")]);
    expect(laid.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});
