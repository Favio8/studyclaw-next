import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StatsLine from "../src/components/chat/StatsLine";

describe("StatsLine", () => {
  it("renders nothing when there are no turns/steps", () => {
    const { container } = render(<StatsLine messages={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders turns for a user message", () => {
    render(
      <StatsLine
        messages={[
          { id: "m1", role: "user", content: "你好", createdAt: new Date().toISOString() },
          { id: "m2", role: "agent", content: "请说明你的理解。", createdAt: new Date().toISOString() },
        ]}
      />,
    );
    expect(screen.getByText(/1 turns/)).toBeInTheDocument();
  });
});
