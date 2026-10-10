import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MarkdownView from "../src/components/chat/MarkdownView";

/**
 * MarkdownView 的 Hook 顺序契约。
 *
 * bubble 分支此前在 `useMemo` 之前提前 return，两次渲染的 Hook 数量不一致
 * ——违反 Rules of Hooks（行为未定义）。bubble 在现网由 message.role 固定，
 * 所以没有立刻崩，但任何让同一实例翻转 bubble 的改动都会踩上它。
 *
 * 断言的是不变量而非崩溃：React 对 Hook 数量变化有各种实现，钉住
 * 「两个分支渲染出等价内容」才是这条修复真正要保证的行为。
 */
afterEach(() => cleanup());

describe("MarkdownView Hook 顺序", () => {
  it("bubble true -> false 切换后渲染出 markdown 结构", () => {
    const { container, rerender } = render(<MarkdownView content="hello world" bubble />);
    expect(container.textContent).toContain("hello world");
    expect(container.querySelector("[data-markdown-view]")).toBeNull();

    rerender(<MarkdownView content="hello world" />);
    expect(container.querySelector("[data-markdown-view]")).not.toBeNull();
    expect(container.textContent).toContain("hello world");
  });

  it("bubble false -> true 切换后回到纯文本", () => {
    const { container, rerender } = render(<MarkdownView content="hello world" />);
    expect(container.querySelector("[data-markdown-view]")).not.toBeNull();

    rerender(<MarkdownView content="hello world" bubble />);
    expect(container.querySelector("[data-markdown-view]")).toBeNull();
    expect(container.textContent).toContain("hello world");
  });

  it("bubble 分支不渲染 markdown 容器（纯文本不经过分段）", () => {
    render(<MarkdownView content={"# 标题\n\n正文"} bubble />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});