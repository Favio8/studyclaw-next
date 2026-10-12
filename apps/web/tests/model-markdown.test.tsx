import { cleanup, render, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import MarkdownView from "../src/components/chat/MarkdownView";
import AskFold from "../src/components/chat/AskFold";
import ThinkingFold from "../src/components/chat/ThinkingFold";
import { normalizeModelMarkdown } from "../src/lib/modelMarkdown";
afterEach(cleanup);
it("renders padded model emphasis, headings, lists, tables and code in compact cards", () => {
  const content = '## 要点\n\n**关键点拆解： **\n\n1. ** 原因 **：保留 `**literal **`。\n\n|概念|说明|\n|---|---|\n|记忆|可更新|\n\n```text\n**literal **\n```';
  const { container } = render(<MarkdownView content={content} compact modelOutput />);
  expect(screen.getByRole("heading", { name: "要点" })).toBeInTheDocument();
  expect(container.querySelectorAll("strong")).toHaveLength(2);
  expect(container.querySelector("ol li")).toHaveTextContent("原因");
  expect(screen.getByRole("table")).toHaveTextContent("记忆");
  expect(container.querySelector("pre code")).toHaveTextContent("**literal **");
  expect(container.querySelector("code:not(pre code)")).toHaveTextContent("**literal **");
});
it("protects complete and streaming code fences, inline code and source Markdown", () => {
  for (const content of ['```md\n** padded **\n```', '~~~md\n** padded **', '    ** padded **', '`** padded **`', '`unfinished ** padded **']) {
    expect(normalizeModelMarkdown(content)).toBe(content);
  }
  const { container } = render(<MarkdownView content="** padded **" compact />);
  expect(container.querySelector("strong")).toBeNull();
  expect(container).toHaveTextContent("** padded **");
});
it("an incomplete streaming emphasis becomes semantic bold when its closing token arrives", () => {
  const { container, rerender } = render(<MarkdownView content="**关键点" compact modelOutput streaming />);
  expect(container.querySelector("strong")).toBeNull();
  rerender(<MarkdownView content={"**关键点 **\n\n- 解释"} compact modelOutput />);
  expect(container.querySelector("strong")).toHaveTextContent("关键点");
  expect(screen.getByRole("list")).toHaveTextContent("解释");
});
it("tutor questions and expanded reasoning use the same renderer", () => {
  const { container } = render(<><AskFold question="为什么 **记忆 **重要？" /><ThinkingFold thinking={"- **第一步 **：分析\n- 第二步"} thinkingMs={1000} /></>);
  expect(container.querySelector("[data-ask-fold] strong")).toHaveTextContent("记忆");
  fireEvent.click(screen.getByRole("button", { name: /已深度思考/ }));
  expect(screen.getByRole("list")).toHaveTextContent("第一步");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});
