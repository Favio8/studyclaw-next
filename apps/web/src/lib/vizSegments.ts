/**
 * sc-interactive 围栏分段器。
 *
 * 把 agent 回复正文按 ```sc-interactive 围栏切成 markdown 段与 viz 段，
 * 供 MarkdownView 在喂给 react-markdown 之前分流（围栏是行级构造，
 * 切分点永远落在块边界，不会切断段落/列表）。
 * 流式期间未闭合的围栏产出 closed:false 的 viz 段，渲染侧据此走占位/降级。
 */

export interface VizSegment {
  type: "md" | "viz";
  /** md 段 = markdown 文本；viz 段 = 围栏内的 HTML 片段 */
  code: string;
  closed: boolean;
  /** 稳定位置 key（类型-出现序号），流式增长过程中同一位置的段 key 不变 */
  key: string;
}

const OPEN_FENCE = /^ {0,3}```\s*sc-interactive\s*$/;
const CLOSE_FENCE = /^ {0,3}```\s*$/;

export function splitVizSegments(content: string): VizSegment[] {
  const segments: VizSegment[] = [];
  let mdLines: string[] = [];
  let vizLines: string[] | null = null;
  let mdCount = 0;
  let vizCount = 0;

  const flushMd = () => {
    const text = mdLines.join("\n");
    mdLines = [];
    if (text.trim().length === 0) return;
    segments.push({ type: "md", code: text, closed: true, key: `md-${mdCount}` });
    mdCount += 1;
  };

  for (const line of content.split(/\r?\n/)) {
    if (vizLines === null) {
      if (OPEN_FENCE.test(line)) {
        flushMd();
        vizLines = [];
      } else {
        mdLines.push(line);
      }
    } else if (CLOSE_FENCE.test(line)) {
      segments.push({
        type: "viz",
        code: vizLines.join("\n"),
        closed: true,
        key: `viz-${vizCount}`,
      });
      vizCount += 1;
      vizLines = null;
    } else {
      vizLines.push(line);
    }
  }

  if (vizLines !== null) {
    segments.push({
      type: "viz",
      code: vizLines.join("\n"),
      closed: false,
      key: `viz-${vizCount}`,
    });
  } else {
    flushMd();
  }

  return segments;
}
