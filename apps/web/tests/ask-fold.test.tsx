import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AskFold from "../src/components/chat/AskFold";
import MessageCard from "../src/components/chat/MessageCard";

describe("AskFold (M-C, ui_design_spec §2.3.1)", () => {
  it("renders the agent ask question and waiting label", () => {
    render(<AskFold question="你说的“亲和性不足”是指硬反亲和性还是软反亲和性？" />);
    expect(screen.getByText("导师提问 · 等待回答")).toBeInTheDocument();
    expect(
      screen.getByText("你说的“亲和性不足”是指硬反亲和性还是软反亲和性？"),
    ).toBeInTheDocument();
  });
});

describe("MessageCard ask integration (M-C: ask 块独立于正文)", () => {
  it("renders AskFold separately from markdown body", () => {
    const { container } = render(
      <MessageCard
        message={{
          id: "m1",
          role: "agent",
          content: "",
          ask: { question: "请澄清：硬亲和还是软亲和？" },
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByText("导师提问 · 等待回答")).toBeInTheDocument();
    expect(
      screen.getByText("请澄清：硬亲和还是软亲和？"),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-ask-fold]")).not.toBeNull();
  });

  it("does not show AskFold when message has no ask", () => {
    const { container } = render(
      <MessageCard
        message={{ id: "m2", role: "agent", content: "正常讲解。", createdAt: new Date().toISOString() }}
      />,
    );
    expect(container.querySelector("[data-ask-fold]")).toBeNull();
    expect(screen.getByText("正常讲解。")).toBeInTheDocument();
  });
});
