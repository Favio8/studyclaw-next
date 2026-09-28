import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 运行能力默认收成一行摘要（5 项里 4 项降级时逐条平铺只是噪音），
 *  点击展开才列出明细——这条交互由本文件固定。 */

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: { activeSessionId: "session-1" as string | null },
  apiMocks: {
    agentProjection: vi.fn(),
    agentStatus: vi.fn(),
    agents: vi.fn(),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
vi.mock("../src/components/panel/PlanPanel", () => ({ default: () => null }));
vi.mock("../src/components/panel/TodoPanel", () => ({ default: () => null }));

import AgentRuntimePanel from "../src/components/panel/AgentRuntimePanel";

const CAPABILITIES = [
  { id: "sandbox", available: false, reason: "未安装 E2B", installAction: "配置 E2B" },
  { id: "subprocess", available: false, reason: "默认拒绝", installAction: null },
  { id: "network", available: true, reason: null, installAction: null },
  { id: "lsp", available: false, reason: "未启用", installAction: null },
  { id: "subagent", available: false, reason: "降级", installAction: null },
];

function projection() {
  return {
    sessionId: "session-1",
    phase: "idle",
    currentModel: { provider: "deepseek", model: "deepseek-flash" },
    modelProvenance: { provider: "", model: "", effort: null, requestId: null },
    agentConfig: null,
    agentRuntime: null,
    messages: [],
    tools: [],
    pendingAsk: null,
    pendingApprovals: [],
    plan: { steps: [], updatedAt: null },
    todos: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, provider: null, model: null },
    cancellation: null,
    maintenance: { running: false, kind: null, lastAt: null },
    maintenanceJobs: [],
    compaction: { count: 0, lastSeq: null, summary: null },
    lineage: { parentSessionId: null, forkSeq: null },
    children: [],
    lastSeq: 42,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentRuntimePanel 运行能力折叠", () => {
  it("默认只显示摘要（项数 + 降级数），明细不渲染", async () => {
    apiMocks.agentProjection.mockResolvedValue(projection());
    apiMocks.agentStatus.mockResolvedValue({ phase: "idle", capabilities: CAPABILITIES });
    apiMocks.agents.mockResolvedValue({ agents: [] });
    render(<AgentRuntimePanel />);

    const toggle = await screen.findByRole("button", { name: /运行能力/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toContain("5 项");
    expect(toggle.textContent).toContain("4 降级");
    // 明细未渲染：逐条的能力行不在 DOM 里。
    expect(screen.queryByTitle(/未安装 E2B/)).toBeNull();
  });

  it("点击摘要展开明细，再点收起", async () => {
    apiMocks.agentProjection.mockResolvedValue(projection());
    apiMocks.agentStatus.mockResolvedValue({ phase: "idle", capabilities: CAPABILITIES });
    apiMocks.agents.mockResolvedValue({ agents: [] });
    render(<AgentRuntimePanel />);

    const toggle = await screen.findByRole("button", { name: /运行能力/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTitle(/未安装 E2B/)).toBeTruthy());
    expect(screen.getByTitle("network")).toBeTruthy();
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTitle(/未安装 E2B/)).toBeNull());
  });

  it("无降级时摘要不带降级数", async () => {
    apiMocks.agentProjection.mockResolvedValue(projection());
    apiMocks.agentStatus.mockResolvedValue({
      phase: "idle",
      capabilities: [{ id: "network", available: true, reason: null, installAction: null }],
    });
    apiMocks.agents.mockResolvedValue({ agents: [] });
    render(<AgentRuntimePanel />);

    const toggle = await screen.findByRole("button", { name: /运行能力/ });
    expect(toggle.textContent).toContain("1 项");
    expect(toggle.textContent).not.toContain("降级");
  });
});
