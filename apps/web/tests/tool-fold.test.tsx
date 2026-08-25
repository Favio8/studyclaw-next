import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ToolFold from "../src/components/chat/ToolFold";
import MessageCard from "../src/components/chat/MessageCard";
import type { ToolCallView } from "../src/types/api";

const tools: ToolCallView[] = [
  {
    name: "search_sources",
    status: "rejected",
    args: { query: "../outside" },
    summary: "非法 path: ../outside",
    error: "非法 path: ../outside",
    durationMs: 3.1,
  },
  {
    name: "read_source",
    status: "success",
    args: { path: "docs/scheduler.md", startLine: 1, endLine: 12 },
    summary: "已读取 docs/scheduler.md 1-12 行（共 120 行）",
    error: null,
    durationMs: 42.5,
  },
];

describe("ToolFold", () => {
  it("renders folded header with last-tool summary and count", () => {
    render(<ToolFold tools={tools} />);
    expect(screen.getByText("工具调用 · 2 次")).toBeInTheDocument();
    // 折叠态：只显示摘要，不显示工具名/参数明细
    expect(screen.getByText("已读取 docs/scheduler.md 1-12 行（共 120 行）")).toBeInTheDocument();
    expect(screen.queryByText("read_source")).not.toBeInTheDocument();
    expect(screen.queryByText(/参数/)).not.toBeInTheDocument();
  });

  it("expands and collapses on click showing per-tool detail", () => {
    const { container } = render(<ToolFold tools={tools} />);
    fireEvent.click(screen.getByText("工具调用 · 2 次"));

    // 展开：工具名 + 状态 + 参数 + 结果 + 错误
    expect(screen.getByText("read_source")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText(/参数.*docs\/scheduler\.md/)).toBeInTheDocument();
    expect(screen.getByText("拒绝")).toBeInTheDocument();
    const resultRows = screen.getAllByText(/结果/);
    expect(resultRows.some((el) => el.textContent?.includes("已读取"))).toBe(true);
    expect(screen.getByText("非法 path: ../outside")).toBeInTheDocument();

    fireEvent.click(screen.getByText("工具调用 · 2 次"));
    expect(screen.queryByText("read_source")).not.toBeInTheDocument();
    expect(container.querySelector('[data-tool-status="rejected"]')).toBeNull();
  });

  it("uses a dedicated icon slot and renders running state", () => {
    const { container } = render(
      <ToolFold
        tools={[{
          callId: "call_1",
          name: "run_quiz",
          status: "running",
          args: {},
          summary: "执行中…",
          error: null,
          durationMs: null,
        }]}
      />,
    );
    fireEvent.click(screen.getByText("工具调用 · 1 次"));
    expect(container.querySelector('[data-tool-icon="run_quiz"] svg')).not.toBeNull();
    expect(container.querySelector('[data-tool-status="running"]')).not.toBeNull();
    expect(screen.getByText("运行中")).toBeInTheDocument();
  });

  it("renders nested calls as a DSH tool tree", () => {
    const { container } = render(<ToolFold tools={[{
      callId: "root", name: "spawn_agent", status: "success", args: { task: "inspect" }, summary: "子 Agent 已排队", error: null, durationMs: 4,
    }, {
      callId: "child", parentCallId: "root", name: "search_files", status: "success", args: { query: "Agent" }, summary: "找到 1 处匹配", error: null, durationMs: 3,
    }]} />);
    fireEvent.click(screen.getByText("工具调用 · 2 次"));
    expect(container.querySelector('[data-tool-parent="root"]')).not.toBeNull();
    expect(screen.getAllByText("找到 1 处匹配").length).toBeGreaterThan(0);
  });
});

describe("MessageCard tool integration (T6.6: tool块独立、不污染正文)", () => {
  it("renders tool fold separately from markdown body", () => {
    const { container } = render(
      <MessageCard
        message={{
          id: "m1",
          role: "agent",
          content: "这是正文答案。",
          tools,
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    // 正文照常渲染
    expect(screen.getByText("这是正文答案。")).toBeInTheDocument();
    // 工具折叠块独立存在
    expect(screen.getByText("工具调用 · 2 次")).toBeInTheDocument();
    expect(container.querySelector("[data-tool-fold]")).not.toBeNull();

    // 折叠块与正文是两个独立元素：正文节点里不含工具摘要
    const fold = container.querySelector("[data-tool-fold]");
    expect(fold).not.toBeNull();
    expect(fold!.textContent).toContain("已读取 docs/scheduler.md");
  });

  it("does not render tool summary inside the markdown content node", () => {
    const { container } = render(
      <MessageCard
        message={{
          id: "m2",
          role: "agent",
          content: "纯正文，不含工具。",
          tools,
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    const marked = container.querySelector("[data-markdown-view]");
    if (marked) {
      expect(marked.textContent).not.toContain("工具调用");
      expect(marked.textContent).not.toContain("read_source");
    }
    expect(screen.getByText("纯正文，不含工具。")).toBeInTheDocument();
  });
});
