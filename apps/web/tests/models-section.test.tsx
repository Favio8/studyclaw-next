import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { flashStatusBanner, apiMocks, catalog, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    code: string;
    status: number;
    // 与真实 api.ts 一致：构造签名 (code, message, status)。
    constructor(code: string, message: string, status = 200) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    flashStatusBanner: vi.fn(),
    ApiError,
    apiMocks: {
      saveProvider: vi.fn(),
      setProviderCredential: vi.fn(),
      deleteProvider: vi.fn(),
      activateProvider: vi.fn(),
      providerCatalog: vi.fn(),
      discoverModels: vi.fn(),
    },
    catalog: [
      {
        id: "deepseek",
        name: "DeepSeek 官方",
        baseUrl: "https://api.deepseek.com",
        models: [],
      },
      {
        id: "sensenova",
        name: "SenseNova 日日新",
        baseUrl: "https://token.sensenova.cn/v1",
        models: [{ id: "sensenova-6.8-flash-lite", name: "S6.8", contextWindow: null, maxTokens: null }],
      },
      { id: "custom", name: "自定义 OpenAI 兼容", baseUrl: null, models: [] },
    ],
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: (selector: (state: { flashStatusBanner: typeof flashStatusBanner }) => unknown) =>
    selector({ flashStatusBanner }),
}));

apiMocks.providerCatalog.mockImplementation(async () => ({ catalog }));

vi.mock("../src/lib/api", () => ({
  api: apiMocks,
  ApiError,
}));

import ModelsSection from "../src/components/settings/ModelsSection";
import type { SettingsPayload } from "../src/types/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makePayload(providers: SettingsPayload["providers"]): SettingsPayload {
  return {
    version: 1,
    activeProviderId: providers.find((p) => p.apiKeyConfigured)?.id ?? "",
    llm: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiBase: null,
      temperature: 0.3,
      maxConcurrency: 4,
      apiKeyConfigured: false,
    },
    providers,
    ui: { defaultMode: "socratic" },
    agent: { preset: "default", presets: [] },
    permissions: { preset: "workspace-write", presets: [] },
    plugins: { inventory: [] },
  };
}

const configuredProvider = {
  id: "acme",
  name: "Acme",
  model: "m1",
  baseUrl: "https://acme.example/v1",
  apiKeyEnv: "ACME_API_KEY",
  apiKeyConfigured: true,
  temperature: 0.3,
  maxConcurrency: 4,
  models: [{ id: "m1", name: "M1", contextWindow: 128000, maxTokens: 8192 }],
};

async function openAdvancedFold() {
  fireEvent.click(screen.getByText("自定义设置"));
  await screen.findByLabelText(/Base URL/);
}

describe("ModelsSection 首次运行与目录添加", () => {
  it("没有任何已配置密钥的 provider 时自动展开目录添加卡", async () => {
    render(<ModelsSection initial={makePayload([])} />);
    expect(await screen.findByText("选择供应商")).toBeTruthy();
    expect(screen.getByText(/模型请手动添加或从端点获取/)).toBeTruthy();
  });

  it("从目录添加：预填 ID/Base URL/默认模型，贴 Key 保存即写入凭据", async () => {
    apiMocks.saveProvider.mockResolvedValue(makePayload([]));
    apiMocks.setProviderCredential.mockResolvedValue(makePayload([]));
    render(<ModelsSection initial={makePayload([])} />);
    await screen.findByText("选择供应商");

    // 目录预填（等目录到达后编辑器挂载）
    expect(await screen.findByPlaceholderText("acme-gateway")).toHaveValue("deepseek");
    await openAdvancedFold();
    expect(screen.getByLabelText(/Base URL/)).toHaveValue("https://api.deepseek.com");
    expect(screen.getByLabelText(/默认模型/)).toHaveValue("");

    const keyInput = screen.getByPlaceholderText("输入 API Key");
    fireEvent.change(keyInput, { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(apiMocks.saveProvider).toHaveBeenCalledTimes(1));
    const profile = apiMocks.saveProvider.mock.calls[0][0];
    expect(profile.id).toBe("deepseek");
    expect(profile.baseUrl).toBe("https://api.deepseek.com");
    expect(profile.models.map((m: { id: string }) => m.id)).toEqual([]);
    expect(apiMocks.setProviderCredential).toHaveBeenCalledWith("deepseek", "sk-test");
    // 横幅点名保存的 provider（显示名优先）
    expect(flashStatusBanner).toHaveBeenCalledWith(expect.stringContaining("DeepSeek 官方"));
  });

  it("自定义声明卡：Base URL 必填、ID 非法时点名且保存被禁用", async () => {
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    fireEvent.click(screen.getByRole("button", { name: /自定义 OpenAI 兼容/ }));

    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toHaveProperty("disabled", true);
    expect(screen.getByText(/自定义网关必须填写 Base URL/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("acme-gateway"), { target: { value: "Bad_ID" } });
    expect(screen.getByText(/必须以小写字母开头/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("acme-gateway"), { target: { value: "my-gw" } });
    fireEvent.change(screen.getByPlaceholderText(/your-gateway/), { target: { value: "https://gw.example/v1" } });
    fireEvent.change(screen.getByPlaceholderText("例如 deepseek-reasoner"), { target: { value: "mx" } });
    expect(save).toHaveProperty("disabled", false);
  });

  it("目录加载失败：显式提示并可重试，不静默禁用一切入口", async () => {
    apiMocks.providerCatalog.mockRejectedValueOnce(new Error("502"));
    render(<ModelsSection initial={makePayload([configuredProvider])} />);

    // 失败提示出现；自定义声明入口不受影响
    expect(await screen.findByRole("alert")).toHaveTextContent(/目录加载失败/);
    const addButton = screen.getByRole("button", { name: /添加供应商/ });
    expect(addButton).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /自定义 OpenAI 兼容/ })).toHaveProperty("disabled", false);

    // 重试成功后提示消失、按钮恢复
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /添加供应商/ })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ModelsSection 行卡片与编辑器", () => {
  it("编辑时行保持可见，编辑器展开在行下方；Key 留空不回写凭据", async () => {
    apiMocks.saveProvider.mockResolvedValue(makePayload([configuredProvider]));
    render(<ModelsSection initial={makePayload([configuredProvider])} />);

    // 已有可用 provider：不出现首次运行卡
    await waitFor(() => expect(screen.queryByText("选择供应商")).toBeNull());
    expect(screen.getByText("Acme")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    // 行仍在（行头 + 编辑器标题都点名 Acme），编辑器在行下方
    expect(screen.getAllByText("Acme").length).toBeGreaterThanOrEqual(1);
    const keyInput = screen.getByPlaceholderText("保留当前密钥，留空不修改");
    expect(keyInput).toBeTruthy();

    await openAdvancedFold();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(apiMocks.saveProvider).toHaveBeenCalledTimes(1));
    expect(apiMocks.setProviderCredential).not.toHaveBeenCalled();
  });

  it("一次只开一张卡：打开添加卡会收起编辑中的行", async () => {
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    await waitFor(() => expect(screen.queryByText("选择供应商")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByPlaceholderText("保留当前密钥，留空不修改")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /添加供应商/ }));
    expect(await screen.findByText("选择供应商")).toBeTruthy();
    expect(screen.queryByPlaceholderText("保留当前密钥，留空不修改")).toBeNull();
  });

  it("删除需确认并点名 provider", async () => {
    apiMocks.deleteProvider.mockResolvedValue(makePayload([]));
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    await waitFor(() => expect(screen.queryByText("选择供应商")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/确定要删除 acme 吗/);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(apiMocks.deleteProvider).toHaveBeenCalledWith("acme"));
  });
});

describe("ModelsSection 模型列表", () => {
  it("从端点获取：已配置候选默认不勾选，采纳只追加未勾选项之外的新行", async () => {
    apiMocks.discoverModels.mockResolvedValue({
      models: [
        { id: "m1", name: "M1", contextWindow: 128000, maxTokens: 8192 },
        { id: "m2", name: "M2", contextWindow: 1000000, maxTokens: null },
      ],
    });
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await openAdvancedFold();

    fireEvent.click(screen.getByRole("button", { name: /从端点获取/ }));
    // 用表单当前值询问：未键入 Key 时回退凭据引用
    await waitFor(() =>
      expect(apiMocks.discoverModels).toHaveBeenCalledWith({
        baseUrl: "https://acme.example/v1",
        apiKey: undefined,
        apiKeyEnv: "ACME_API_KEY",
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: "选择要添加的模型" });
    expect(dialog).toBeTruthy();
    const m1 = screen.getByLabelText(/m1/) as HTMLInputElement;
    const m2 = screen.getByLabelText(/m2/) as HTMLInputElement;
    expect(m1.checked).toBe(false); // 已配置：默认不勾选
    expect(m2.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /采纳所选（1）/ }));
    expect(await screen.findByLabelText(`模型 ID 2`)).toHaveValue("m2");
    // 容量随候选带出（1M 解析展示）
    expect(screen.getByLabelText("上下文窗口 2")).toHaveValue("1M");
  });

  it("容量支持 K/M 后缀，非法时点名行并禁用保存", async () => {
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await openAdvancedFold();

    fireEvent.click(screen.getByRole("button", { name: /手动添加/ }));
    fireEvent.change(screen.getByLabelText("模型 ID 2"), { target: { value: "m3" } });
    // 新行自己的容量折叠区（第 2 个 summary；第 1 个属于已有行 m1）
    fireEvent.click(screen.getAllByText("容量（可选）")[1]);
    const context = screen.getByLabelText("上下文窗口 2");
    fireEvent.change(context, { target: { value: "1M" } });
    expect(screen.queryByText(/容量格式无效/)).toBeNull();

    fireEvent.change(context, { target: { value: "abc" } });
    expect(screen.getByText(/第 2 行容量格式无效/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
  });
});

describe("ModelsSection 批次1（X2/X3/X4/X5）", () => {
  it("X2 编辑既有 Provider：温度/并发从 provider 真实值初始化，不再硬编码重置", async () => {
    const tuned = {
      ...configuredProvider,
      temperature: 0.7,
      maxConcurrency: 6,
    };
    apiMocks.saveProvider.mockResolvedValue(makePayload([tuned]));
    render(<ModelsSection initial={makePayload([tuned])} />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await openAdvancedFold();

    expect(screen.getByLabelText(/温度（temperature）/)).toHaveValue(0.7);
    expect(screen.getByLabelText(/最大并发（maxConcurrency）/)).toHaveValue(6);

    fireEvent.change(screen.getByLabelText(/温度（temperature）/), { target: { value: "1.2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(apiMocks.saveProvider).toHaveBeenCalledTimes(1));
    const profile = apiMocks.saveProvider.mock.calls[0][0];
    expect(profile.temperature).toBe(1.2);
    expect(profile.maxConcurrency).toBe(6);
    // 编辑态必须带 overwrite（更新既有 id，不触发 409）。
    expect(profile.overwrite).toBe(true);
  });

  it("X3 添加卡有目录来源时显示「恢复内置列表」，点击回到目录预置", async () => {
    render(<ModelsSection initial={makePayload([])} />);
    await screen.findByText("选择供应商");
    // 等目录到达、编辑器挂载（初始选中 deepseek，无预置模型）。
    await screen.findByPlaceholderText("acme-gateway");
    // 切到 sensenova（预置 1 个模型）。
    fireEvent.change(screen.getByLabelText(/选择供应商/), { target: { value: "sensenova" } });
    await screen.findByDisplayValue("sensenova-6.8-flash-lite");
    // sensenova 预置模型已在列表；改掉后点「恢复内置列表」应回到预置。
    fireEvent.change(screen.getByLabelText("模型 ID 1"), { target: { value: "custom-x" } });
    expect(screen.getByLabelText("模型 ID 1")).toHaveValue("custom-x");
    fireEvent.click(screen.getByRole("button", { name: /恢复内置列表/ }));
    expect(screen.getByLabelText("模型 ID 1")).toHaveValue("sensenova-6.8-flash-lite");
  });

  it("X4 切换目录条目不丢已填草稿（切走再切回仍在）", async () => {
    render(<ModelsSection initial={makePayload([])} />);
    await screen.findByText("选择供应商");
    // 等目录到达、编辑器挂载。
    await screen.findByPlaceholderText("acme-gateway");
    const providerSelect = screen.getByLabelText(/选择供应商/);

    // 当前条目（deepseek）填 Key + 手填一个模型
    fireEvent.change(screen.getByPlaceholderText("输入 API Key"), { target: { value: "sk-ds" } });
    await openAdvancedFold();
    fireEvent.click(screen.getByRole("button", { name: "＋ 手动添加" }));
    fireEvent.change(await screen.findByLabelText("模型 ID 1"), { target: { value: "custom-1" } });

    // 切到 sensenova 再切回 deepseek：模型行保留；API Key 按新安全契约
    // （FE-4）不进草稿缓存——切走即丢弃未提交密钥，返回后为空，防明文驻留。
    fireEvent.change(providerSelect, { target: { value: "sensenova" } });
    await screen.findByDisplayValue("sensenova-6.8-flash-lite");
    fireEvent.change(providerSelect, { target: { value: "deepseek" } });
    expect(screen.getByPlaceholderText("输入 API Key")).toHaveValue("");
    expect(screen.getByLabelText("模型 ID 1")).toHaveValue("custom-1");
  });

  it("X5 创建撞已存在 id：后端 409 弹确认框，点覆盖带 overwrite 重发", async () => {
    apiMocks.saveProvider
      .mockRejectedValueOnce(new ApiError("provider-exists", "Provider acme 已存在（覆盖前请先确认）", 200))
      .mockResolvedValueOnce(makePayload([configuredProvider]));
    render(<ModelsSection initial={makePayload([])} />);
    await screen.findByText("选择供应商");
    // 等目录到达、编辑器挂载。
    await screen.findByPlaceholderText("acme-gateway");

    // 创建态默认 id = deepseek；改成已存在的 acme 触发 409 路径。
    fireEvent.change(screen.getByPlaceholderText("acme-gateway"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const dialog = await screen.findByRole("dialog", { name: "Provider 已存在" });
    expect(dialog).toHaveTextContent(/acme/);

    fireEvent.click(within(dialog).getByRole("button", { name: "覆盖" }));
    await waitFor(() => expect(apiMocks.saveProvider).toHaveBeenCalledTimes(2));
    const second = apiMocks.saveProvider.mock.calls[1][0];
    expect(second.overwrite).toBe(true);
  });
});

describe("ModelsSection 防自动填充", () => {
  it("新建表单使用 new-password 语义与密码管理器忽略标记", async () => {
    render(<ModelsSection initial={makePayload([configuredProvider])} />);
    // 等目录到达（添加按钮在目录为空时禁用）
    const addButton = await screen.findByRole("button", { name: /添加供应商/ });
    await waitFor(() => expect(addButton).toHaveProperty("disabled", false));
    fireEvent.click(addButton);
    await screen.findByText("选择供应商");

    const keyInput = screen.getByPlaceholderText("输入 API Key");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(keyInput).toHaveAttribute("autocomplete", "new-password");
    expect(keyInput).toHaveAttribute("data-form-type", "other");
    expect(keyInput).toHaveAttribute("data-1p-ignore", "true");
  });
});
