/**
 * F1/G2：模型配置「保存并测试」回归。
 *
 * 保存会收起编辑卡，内联结果可能不可见——测试结论必须同时用全局横幅透出，
 * 不能只在卡片里显示（否则用户点了按钮看不到任何结果）。
 * 同时验证连通测试走真实生成接口，而不是「获取模型列表」。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    flashStatusBanner: vi.fn(),
  },
  apiMocks: {
    providerCatalog: vi.fn(async () => ({ catalog: [] })),
    saveProvider: vi.fn(),
    setProviderCredential: vi.fn(),
    testProvider: vi.fn(),
    discoverModels: vi.fn(),
    deleteProvider: vi.fn(),
    activateProvider: vi.fn(),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error {},
}));

import ModelsSection from "../src/components/settings/ModelsSection";

const payload = {
  version: 1,
  activeProviderId: "deepseek",
  llm: {
    provider: "deepseek",
    model: "deepseek-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiBase: "https://api.deepseek.com",
    temperature: 0.3,
    maxConcurrency: 2,
    apiKeyConfigured: true,
    readModel: null,
    readEffort: null,
  },
  providers: [{
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKeyConfigured: true,
    temperature: 0.3,
    maxConcurrency: 2,
    models: [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 8192 }],
  }],
  ui: { defaultMode: "socratic" },
  parse: { engine: "builtin", tier: "basic", timeoutSec: 300, concurrency: 1, mineru: { available: false, command: null, reason: null } },
  agent: { preset: "studyclaw-learning", presets: [] },
  permissions: { preset: "workspace-write", presets: [] },
  plugins: { inventory: [] },
} as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.removeItem("studyclaw.modelTest.v1");
});

describe("模型配置 · 保存并测试", () => {
  it("点击后保存配置并发起真实连通测试，结果用全局横幅透出", async () => {
    apiMocks.saveProvider.mockResolvedValue(payload);
    apiMocks.testProvider.mockResolvedValue({ ok: true, providerId: "deepseek", model: "deepseek-flash", latencyMs: 321, message: "连接成功" });

    render(<ModelsSection initial={payload} />);
    // 展开已有供应商的编辑卡。
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const testButton = await screen.findByRole("button", { name: "保存并测试" });
    expect(testButton).toBeInTheDocument();

    fireEvent.click(testButton);
    await waitFor(() => expect(apiMocks.testProvider).toHaveBeenCalledWith("deepseek"));
    await waitFor(() => expect(storeState.flashStatusBanner).toHaveBeenCalledWith(expect.stringContaining("连通测试成功")));
    // 成功证据落盘，供引导 G2 使用。
    expect(window.localStorage.getItem("studyclaw.modelTest.v1")).toContain("deepseek-flash");
  });

  it("测试失败时用横幅给出原因，且不写入成功证据", async () => {
    apiMocks.saveProvider.mockResolvedValue(payload);
    apiMocks.testProvider.mockResolvedValue({ ok: false, providerId: "deepseek", model: "deepseek-flash", latencyMs: 88, message: "Authentication Fails, invalid api key" });

    render(<ModelsSection initial={payload} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并测试" }));

    await waitFor(() => expect(storeState.flashStatusBanner).toHaveBeenCalledWith(expect.stringContaining("连通测试失败")));
    expect(window.localStorage.getItem("studyclaw.modelTest.v1")).toBeNull();
  });
});
