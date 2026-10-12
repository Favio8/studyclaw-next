import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    settingsOpen: true,
    settingsSection: "general",
    setSettingsOpen: vi.fn(),
    setMode: vi.fn(),
    flashStatusBanner: vi.fn(),
  },
  apiMocks: {
    settings: vi.fn(),
    updateSettings: vi.fn(),
    providerCatalog: vi.fn(async () => ({ catalog: [] })),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock("../src/lib/api", () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error {},
}));

import SettingsDialog from "../src/components/settings/SettingsDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.settingsOpen = true;
});

const payload = {
  version: 1,
  activeProviderId: "deepseek",
  llm: {
    provider: "deepseek",
    model: "deepseek-reasoner",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiBase: null,
    temperature: 0.3,
    maxConcurrency: 4,
    apiKeyConfigured: false,
  },
  providers: [],
  ui: { defaultMode: "socratic" as const },
};

describe("SettingsDialog 通用设置（部分更新语义）", () => {
  it("关闭再打开重新加载草稿并重新建立焦点圈闭", async () => {
    apiMocks.settings.mockResolvedValue(payload);
    const { rerender } = render(<SettingsDialog />);
    const mode = await screen.findByRole("combobox", { name: /默认学习模式/ });
    fireEvent.change(mode, { target: { value: "quick" } });
    storeState.settingsOpen = false;
    rerender(<SettingsDialog />);
    storeState.settingsOpen = true;
    rerender(<SettingsDialog />);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(await screen.findByRole("combobox", { name: /默认学习模式/ })).toHaveValue("socratic");
    expect(apiMocks.settings).toHaveBeenCalledTimes(2);
  });
  it("保存只发送 defaultMode，不再隐式回写旧 llm 段", async () => {
    apiMocks.settings.mockResolvedValue(payload);
    apiMocks.updateSettings.mockResolvedValue({
      ...payload,
      ui: { defaultMode: "quick" as const },
    });

    render(<SettingsDialog />);
    // 模型配置 Tab 的目录请求不应在通用 Tab 触发
    expect(await screen.findByText("学习体验")).toBeTruthy();
    expect(apiMocks.providerCatalog).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: /默认学习模式/ }), {
      target: { value: "quick" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(apiMocks.updateSettings).toHaveBeenCalledTimes(1));
    expect(apiMocks.updateSettings).toHaveBeenCalledWith({ defaultMode: "quick" });
    expect(storeState.setMode).toHaveBeenCalledWith("quick");
    expect(storeState.flashStatusBanner).toHaveBeenCalledWith("设置已保存");
  });
});
