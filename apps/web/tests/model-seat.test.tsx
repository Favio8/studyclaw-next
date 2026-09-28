import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    activeModel: null as { providerId: string; model: string; effort?: string | null } | null,
    activeCourseId: "course-1",
    activeSessionId: "session-1",
    setActiveModel: vi.fn(),
    flashStatusBanner: vi.fn(),
    setSettingsOpen: vi.fn(),
  },
  apiMocks: { sessionModels: vi.fn(), selectSessionModel: vi.fn(), settings: vi.fn() },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign((selector: (state: typeof storeState) => unknown) => selector(storeState), { getState: () => storeState }),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks, ApiError: class ApiError extends Error {} }));

import ModelSeat from "../src/components/chat/ModelSeat";

const directory = {
  current: { provider: "acme", model: "acme-small" },
  routable: true,
  groups: [
    { id: "acme", name: "Acme", models: [{ id: "acme-small", name: "Acme Small", contextWindow: null, maxTokens: null }, { id: "acme-large", name: "Acme Large", contextWindow: null, maxTokens: null }] },
    { id: "other", name: "Other", models: [{ id: "other-1", name: "Other One", contextWindow: null, maxTokens: null }] },
  ],
  failures: [],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); storeState.activeModel = null; });
storeState.setActiveModel.mockImplementation((value: { providerId: string; model: string; effort?: string | null } | null) => { storeState.activeModel = value; });

describe("ModelSeat 输入栏模型座位", () => {
  it("打开后按 DSH 两级菜单展示 provider 分组并播种当前模型", async () => {
    apiMocks.sessionModels.mockResolvedValue(directory);
    render(<ModelSeat />);
    fireEvent.click(screen.getByRole("button", { name: /选择模型/ }));
    expect(await screen.findByRole("menu", { name: "选择模型" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(await screen.findByRole("menuitemradio", { name: /Acme Small/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("group", { name: "Other" })).toBeTruthy();
    expect(apiMocks.sessionModels).toHaveBeenCalledWith("course-1", "session-1");
  });

  it("选择具体模型写入会话而不是切换全局 provider", async () => {
    apiMocks.sessionModels.mockResolvedValue(directory);
    apiMocks.selectSessionModel.mockResolvedValue({ selected: { provider: "other", model: "other-1" } });
    storeState.activeModel = { providerId: "acme", model: "acme-small" };
    render(<ModelSeat />);
    fireEvent.click(screen.getByRole("button", { name: /acme-small/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Other One" }));
    await waitFor(() => expect(apiMocks.selectSessionModel).toHaveBeenCalledWith("course-1", "session-1", { provider: "other", model: "other-1" }));
    expect(storeState.setActiveModel).toHaveBeenCalledWith({ providerId: "other", model: "other-1" });
  });

  it("目录为空时引导打开模型配置", async () => {
    apiMocks.sessionModels.mockResolvedValue({ current: null, routable: false, groups: [], failures: [] });
    render(<ModelSeat />);
    fireEvent.click(screen.getByRole("button", { name: /选择模型/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(await screen.findByText("还没有可用模型。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开模型配置" }));
    expect(storeState.setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it("在模型目录中选择思考强度并支持恢复模型默认", async () => {
    const withEffort = {
      ...directory,
      current: { provider: "acme", model: "acme-small", effort: "high" },
      groups: [{ ...directory.groups[0], models: [{ ...directory.groups[0].models[0], efforts: [
        { id: "off", name: "Off" },
        { id: "high", name: "High", description: "更深的推理" },
      ] }] }],
    };
    apiMocks.sessionModels.mockResolvedValue(withEffort);
    apiMocks.selectSessionModel.mockResolvedValue({ selected: { provider: "acme", model: "acme-small", effort: null } });
    storeState.activeModel = { providerId: "acme", model: "acme-small", effort: "high" };
    render(<ModelSeat />);
    fireEvent.click(screen.getByRole("button", { name: /acme-small/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "思考强度" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /跟随模型默认/ }));
    await waitFor(() => expect(apiMocks.selectSessionModel).toHaveBeenCalledWith("course-1", "session-1", { provider: "acme", model: "acme-small", effort: null }));
    expect(storeState.setActiveModel).toHaveBeenCalledWith({ providerId: "acme", model: "acme-small", effort: null });
  });

  it("Escape 先返回根菜单，再关闭", async () => {
    apiMocks.sessionModels.mockResolvedValue(directory);
    render(<ModelSeat />);
    fireEvent.click(screen.getByRole("button", { name: /选择模型/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("menuitem", { name: /模型/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("模型名已含厂商名时不再重复显示 provider（DeepSeek-V4.1-Flash · deepseek）", async () => {
    apiMocks.sessionModels.mockResolvedValue({
      current: { provider: "deepseek", model: "DeepSeek-V4.1-Flash" },
      routable: true,
      groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash", contextWindow: null, maxTokens: null }] }],
      failures: [],
    });
    storeState.activeModel = { providerId: "deepseek", model: "DeepSeek-V4.1-Flash" };
    render(<ModelSeat />);
    const seat = screen.getByRole("button", { name: /DeepSeek-V4\.1-Flash/ });
    expect(seat.textContent).not.toContain("deepseek");
    // 完整信息不丢：悬停 title 里仍有 provider / model id。
    expect(seat.getAttribute("title")).toContain("provider: deepseek");
    expect(seat.getAttribute("title")).toContain("id: DeepSeek-V4.1-Flash");
  });

  it("provider 补充信息时仍显示（qwen3.8-27b-fp8 · qwen-lab）", async () => {
    storeState.activeModel = { providerId: "qwen-lab", model: "qwen3.8-27b-fp8" };
    render(<ModelSeat />);
    const seat = screen.getByRole("button", { name: /qwen3\.8-27b-fp8/ });
    expect(seat.textContent).toContain("qwen-lab");
  });

  it("设置了思考强度时在座位里带出小徽章", async () => {
    const withEffort = {
      ...directory,
      current: { provider: "acme", model: "acme-small", effort: "high" },
      groups: [{ ...directory.groups[0], models: [{ ...directory.groups[0].models[0], efforts: [
        { id: "off", name: "Off" },
        { id: "high", name: "High", description: "更深的推理" },
      ] }] }],
    };
    apiMocks.sessionModels.mockResolvedValue(withEffort);
    storeState.activeModel = { providerId: "acme", model: "acme-small", effort: "high" };
    render(<ModelSeat />);
    // 先打开一次菜单让目录加载（efforts 的显示名来自目录），否则徽章只能回落原始 id。
    // 打开前 caption 是 model id（acme-small），打开后目录加载、caption 变成显示名
    // （Acme Small）——所以两步用不同匹配。
    fireEvent.click(screen.getByRole("button", { name: /acme-small/ }));
    await screen.findByRole("menu", { name: "选择模型" });
    const seat = screen.getByRole("button", { name: /acme small/i });
    expect(seat.textContent).toContain("High");
    expect(seat.getAttribute("title")).toContain("思考强度: High");
  });

  it("未设置思考强度时不显示徽章（不制造噪音）", async () => {
    apiMocks.sessionModels.mockResolvedValue(directory);
    storeState.activeModel = { providerId: "acme", model: "acme-small" };
    render(<ModelSeat />);
    const seat = screen.getByRole("button", { name: /acme-small/ });
    expect(seat.textContent).not.toContain("跟随模型默认");
    expect(seat.getAttribute("title") ?? "").not.toContain("思考强度");
  });
});
