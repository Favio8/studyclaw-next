import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import InteractiveViz from "../src/components/chat/InteractiveViz";
import MessageCard from "../src/components/chat/MessageCard";
import { vizHeightFromEvent } from "../src/lib/vizTheme";

const FENCE = "```";
const VIZ_CODE = '<button onclick="this.textContent=\'ok\'">点我</button>';

function renderClosed(code = VIZ_CODE) {
  return render(<InteractiveViz code={code} closed />);
}

describe("InteractiveViz 三态分支", () => {
  it("流式未闭合 → 占位卡，无 iframe", () => {
    const { container } = render(<InteractiveViz code="<div>半截" closed={false} streaming />);
    expect(screen.getByText("交互演示生成中…")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-viz-state="generating"]')).not.toBeNull();
  });

  it("终态未闭合 → 降级代码块，无 iframe", () => {
    const { container } = render(<InteractiveViz code="<div>半截" closed={false} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-viz-state="fallback"]')).not.toBeNull();
    expect(screen.getByText("sc-interactive")).toBeInTheDocument();
    expect(screen.getByText("<div>半截")).toBeInTheDocument();
  });

  it("闭合 → 卡片 + sandbox 恰为 allow-scripts 的 iframe", () => {
    const { container } = renderClosed();
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe!.getAttribute("title")).toBe("交互演示");
    expect(screen.getByText("交互演示", { selector: "span" })).toBeInTheDocument();
  });

  it("srcDoc 含 CSP 断网、主题桥与原始片段", () => {
    const { container } = renderClosed();
    const doc = container.querySelector("iframe")!.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("--color-text-primary: rgb(15, 17, 21)");
    expect(doc).toContain("--color-border-tertiary"); // 别名兼容层
    expect(doc).toContain(VIZ_CODE);
    expect(doc).toContain("sc-viz-height"); // 高度上报脚本
    expect(doc).not.toContain("allow-same-origin");
  });

  it("源码按钮展开/收起原始片段", () => {
    const { container } = renderClosed();
    const toggle = screen.getByText("源码");
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector('[data-viz-state="ready"] pre')?.textContent).toContain("点我");
    fireEvent.click(toggle);
    expect(container.querySelector('[data-viz-state="ready"] pre')).toBeNull();
  });
});

describe("InteractiveViz 高度自适应", () => {
  it("初始高度 96，收到合法高度消息后更新并 +2", () => {
    const { container } = renderClosed();
    const iframe = container.querySelector("iframe")!;
    expect(iframe.style.height).toBe("96px");
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "sc-viz-height", h: 200 },
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe("202px");
  });

  it("高度被夹在 40~640 之间", () => {
    const { container } = renderClosed();
    const iframe = container.querySelector("iframe")!;
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "sc-viz-height", h: 5000 },
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe("640px");
  });

  it("忽略来源不符或形状非法的消息", () => {
    const { container } = renderClosed();
    const iframe = container.querySelector("iframe")!;
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "sc-viz-height", h: 300 },
        source: null, // 非本 iframe
      }),
    );
    fireEvent(window, new MessageEvent("message", { data: "noise" }));
    expect(iframe.style.height).toBe("96px");
  });

  it("vizHeightFromEvent 纯函数：类型与数值校验", () => {
    const src = {} as Window;
    const ok = new MessageEvent("message", { data: { type: "sc-viz-height", h: 10 }, source: src });
    expect(vizHeightFromEvent(src, ok)).toBe(10);
    expect(vizHeightFromEvent(null, ok)).toBeNull();
    expect(vizHeightFromEvent(src, new MessageEvent("message", { data: { type: "other", h: 1 }, source: src }))).toBeNull();
    expect(vizHeightFromEvent(src, new MessageEvent("message", { data: { type: "sc-viz-height", h: "12" }, source: src }))).toBeNull();
    expect(vizHeightFromEvent(src, new MessageEvent("message", { data: null, source: src }))).toBeNull();
  });
});

describe("InteractiveViz 防 remount（流式重渲不重置交互状态）", () => {
  it("code 不变时 iframe 元素与 srcDoc 保持稳定", () => {
    const { container, rerender } = renderClosed();
    const iframe = container.querySelector("iframe")!;
    const docBefore = iframe.getAttribute("srcdoc");
    // 模拟父级流式重渲（streaming 标志变化、code 已冻结）
    rerender(<InteractiveViz code={VIZ_CODE} closed streaming={false} />);
    const after = container.querySelector("iframe")!;
    expect(after).toBe(iframe); // 同一 DOM 节点，未 remount
    expect(after.getAttribute("srcdoc")).toBe(docBefore);
  });
});

describe("MessageCard 集成（sc-interactive 进出消息流）", () => {
  it("闭合围栏渲染为交互卡片，前后 markdown 正常", () => {
    const { container } = render(
      <MessageCard
        message={{
          id: "v1",
          role: "agent",
          content: `看这个：\n\n${FENCE}sc-interactive\n<div>hi</div>\n${FENCE}\n\n试着点一下。`,
        }}
      />,
    );
    expect(container.querySelector('[data-viz-state="ready"]')).not.toBeNull();
    expect(screen.getByText("看这个：")).toBeInTheDocument();
    expect(screen.getByText("试着点一下。")).toBeInTheDocument();
  });

  it("流式中未闭合围栏走占位卡", () => {
    const { container } = render(
      <MessageCard
        message={{
          id: "v2",
          role: "agent",
          content: `前文\n${FENCE}sc-interactive\n<div>半截`,
          streaming: true,
        }}
      />,
    );
    expect(container.querySelector('[data-viz-state="generating"]')).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
