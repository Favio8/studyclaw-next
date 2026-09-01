import { describe, expect, it } from "vitest";
import { splitVizSegments } from "../src/lib/vizSegments";

const FENCE = "```";

describe("splitVizSegments", () => {
  it("returns a single md segment for plain markdown", () => {
    const segs = splitVizSegments("一段正文。\n\n- 列表项");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: "md", closed: true, key: "md-0" });
    expect(segs[0].code).toBe("一段正文。\n\n- 列表项");
  });

  it("splits md / viz / md around a closed fence", () => {
    const content = `前面正文。

${FENCE}sc-interactive
<div>演示</div>
${FENCE}

后面正文。`;
    const segs = splitVizSegments(content);
    expect(segs.map((s) => s.type)).toEqual(["md", "viz", "md"]);
    expect(segs[1]).toMatchObject({
      code: "<div>演示</div>",
      closed: true,
      key: "viz-0",
    });
    expect(segs[0].key).toBe("md-0");
    expect(segs[2].key).toBe("md-1");
  });

  it("numbers multiple viz blocks in order", () => {
    const content = [
      FENCE + "sc-interactive",
      "<p>1</p>",
      FENCE,
      "中间",
      FENCE + "sc-interactive",
      "<p>2</p>",
      FENCE,
    ].join("\n");
    const segs = splitVizSegments(content);
    const vizKeys = segs.filter((s) => s.type === "viz").map((s) => s.key);
    expect(vizKeys).toEqual(["viz-0", "viz-1"]);
  });

  it("marks a trailing unclosed fence as closed:false", () => {
    const segs = splitVizSegments(`前文。

${FENCE}sc-interactive
<div>半截`);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toMatchObject({
      type: "viz",
      closed: false,
      code: "<div>半截",
      key: "viz-0",
    });
  });

  it("treats a bare fence inside viz as the closing fence (容错)", () => {
    const content = `${FENCE}sc-interactive
<div>
${FENCE}
剩余正文`;
    const segs = splitVizSegments(content);
    expect(segs.map((s) => s.type)).toEqual(["viz", "md"]);
    expect(segs[0].code).toBe("<div>");
    expect(segs[1].code).toBe("剩余正文");
  });

  it("handles CRLF line endings", () => {
    const segs = splitVizSegments(
      `前文。\r\n${FENCE}sc-interactive\r\n<div>x</div>\r\n${FENCE}\r\n后文。`,
    );
    expect(segs.map((s) => s.type)).toEqual(["md", "viz", "md"]);
    expect(segs[1]).toMatchObject({ code: "<div>x</div>", closed: true });
  });

  it("skips empty leading/trailing md segments", () => {
    const segs = splitVizSegments(`${FENCE}sc-interactive\n<div>x</div>\n${FENCE}`);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: "viz", closed: true });
  });

  it("keeps other-language fences inside md segments", () => {
    const content = `${FENCE}python\nprint(1)\n${FENCE}`;
    const segs = splitVizSegments(content);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("md");
  });

  it("accepts up to 3 leading spaces on fences but not 4", () => {
    const opens = splitVizSegments(`   ${FENCE}sc-interactive\n<div>x</div>\n   ${FENCE}`);
    expect(opens).toHaveLength(1);
    expect(opens[0].type).toBe("viz");

    const notOpens = splitVizSegments(`    ${FENCE}sc-interactive\n<div>x</div>\n    ${FENCE}`);
    expect(notOpens).toHaveLength(1);
    expect(notOpens[0].type).toBe("md");
  });

  it("accepts whitespace around the info string", () => {
    const segs = splitVizSegments(`${FENCE} sc-interactive \n<div>x</div>\n${FENCE}`);
    expect(segs[0].type).toBe("viz");
  });

  it("keeps keys stable as streaming content grows", () => {
    const frames = [
      "段落",
      `段落\n${FENCE}sc-intera`,
      `段落\n${FENCE}sc-interactive\n<div>`,
      `段落\n${FENCE}sc-interactive\n<div>\n${FENCE}`,
      `段落\n${FENCE}sc-interactive\n<div>\n${FENCE}\n结尾`,
    ];
    const perFrame = frames.map((f) => splitVizSegments(f));
    // 围栏成形后：md-0 与 viz-0 的 key 在后续所有帧保持稳定
    for (const segs of perFrame.slice(2)) {
      expect(segs[0].key).toBe("md-0");
      expect(segs[1].key).toBe("viz-0");
    }
    expect(perFrame[3][1].closed).toBe(true);
    expect(perFrame[4]).toHaveLength(3);
    expect(perFrame[4][2].key).toBe("md-1");
  });
});
