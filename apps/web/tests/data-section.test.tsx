/**
 * 设置 → 数据分区：导出 / 导入 / 桌面专属入口。
 *
 * 重点钉三件容易被"看起来能跑"掩盖的事：
 * 1. 导出物走**二进制**通道（JSON+base64 会被 2 MiB 请求体上限截断）；
 * 2. 覆盖同名课程必须**显式勾选**，且勾选后还要二次确认；
 * 3. 「打开数据目录」只在桌面宿主下出现，纯 Web 端不留死按钮。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exportCourse, importCourse } = vi.hoisted(() => ({
  exportCourse: vi.fn(),
  importCourse: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { exportCourse, importCourse },
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 200) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

const storeState = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试桩需按场景改写
  const state: any = { activeCourseId: "机器学习" };
  return state;
});
vi.mock("../src/store/useAppStore", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 storeState 同理
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

import DataSection from "../src/components/settings/DataSection";

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const realAnchorClick = HTMLAnchorElement.prototype.click;
const realArrayBuffer = Blob.prototype.arrayBuffer;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
  // jsdom 不实现导航；下载用的 <a download> 点击必须在这里吞掉。
  HTMLAnchorElement.prototype.click = vi.fn();
  // jsdom 的 Blob 既没有 arrayBuffer() 也没有 text()（浏览器里都有），
  // 补一个最小的 arrayBuffer，否则上传路径根本没被测到。
  Blob.prototype.arrayBuffer = async function arrayBuffer(this: Blob) {
    return new ArrayBuffer(this.size);
  };
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  HTMLAnchorElement.prototype.click = realAnchorClick;
  Blob.prototype.arrayBuffer = realArrayBuffer;
  vi.unstubAllGlobals();
  exportCourse.mockReset();
  importCourse.mockReset();
  storeState.activeCourseId = "机器学习";
  delete (window as unknown as { studyclawDesktop?: unknown }).studyclawDesktop;
});

function selectArchive(name = "backup.zip", body = "PK"): HTMLInputElement {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  if (input === null) throw new Error("找不到备份文件输入框");
  const file = new File([body], name, { type: "application/zip" });
  // jsdom 的 input.files 是只读访问器，必须在实例上定义自己的属性才能注入。
  Object.defineProperty(input, "files", { value: [file], configurable: true, writable: true });
  fireEvent.change(input);
  return input;
}

describe("设置 · 数据分区", () => {
  it("导出走二进制通道并触发下载", async () => {
    exportCourse.mockResolvedValue({ blob: new Blob(["x"], { type: "text/markdown" }), filename: "机器学习-2026-10-11.md" });
    render(<DataSection />);

    fireEvent.click(screen.getByRole("button", { name: /导出 Markdown/ }));

    await waitFor(() => expect(exportCourse).toHaveBeenCalledWith("机器学习", "markdown"));
    expect(URL.createObjectURL).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已导出"));
  });

  it("未打开课程时导出给出可读错误而不是发请求", async () => {
    storeState.activeCourseId = null;
    render(<DataSection />);
    fireEvent.click(screen.getByRole("button", { name: /导出 Markdown/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("尚未打开"));
    expect(exportCourse).not.toHaveBeenCalled();
  });

  it("未勾选覆盖时按默认语义提交（force=false）", async () => {
    importCourse.mockResolvedValue({ courseId: "机器学习", files: 7 });
    render(<DataSection />);
    selectArchive();
    // 自检：文件必须真的进了组件状态，否则下面的断言只是在测一个空点击。
    expect(screen.getByText("backup.zip")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "开始还原" }));

    await waitFor(() => expect(importCourse).toHaveBeenCalled());
    const [, opts] = importCourse.mock.calls[0]!;
    expect(opts).toMatchObject({ force: false });
  });

  it("勾选覆盖后必须二次确认；用户取消则不发送", async () => {
    render(<DataSection />);
    selectArchive();
    fireEvent.click(screen.getByRole("checkbox"));
    vi.mocked(confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "开始还原" }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(importCourse).not.toHaveBeenCalled();
  });

  it("勾选覆盖并确认后才真正提交", async () => {
    importCourse.mockResolvedValue({ courseId: "期末复习", files: 9 });
    render(<DataSection />);
    selectArchive();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "开始还原" }));

    await waitFor(() => expect(importCourse).toHaveBeenCalled());
    expect(importCourse.mock.calls[0]![1]).toMatchObject({ force: true });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("期末复习"));
  });

  it("目标已存在给出可操作的提示，而不是原始错误", async () => {
    const { ApiError } = await import("../src/lib/api");
    importCourse.mockRejectedValue(new ApiError("target-exists", "raw", 400));
    render(<DataSection />);
    selectArchive();
    fireEvent.click(screen.getByRole("button", { name: "开始还原" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("覆盖同名课程"));
  });

  it("版本不支持 / 文件非法 / 体积超限 各有独立提示", async () => {
    const { ApiError } = await import("../src/lib/api");
    const cases: Array<[string, string]> = [
      ["unsupported-version", "更高版本"],
      ["invalid-archive", "不是有效"],
      ["payload-too-large", "太大"],
    ];
    for (const [code, expected] of cases) {
      importCourse.mockRejectedValueOnce(new ApiError(code, "raw", 400));
      const view = render(<DataSection />);
      selectArchive();
      fireEvent.click(screen.getByRole("button", { name: "开始还原" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(expected));
      view.unmount();
      cleanup();
    }
  });

  it("未选文件时「开始还原」不可点，也不会发请求", async () => {
    render(<DataSection />);
    const button = screen.getByRole("button", { name: "开始还原" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(importCourse).not.toHaveBeenCalled();
  });

  it("纯 Web 端不显示「打开数据目录」；桌面宿主下显示并可点击", async () => {
    const openDataDir = vi.fn().mockResolvedValue({ opened: true });
    const view = render(<DataSection />);
    expect(screen.queryByRole("button", { name: "打开数据目录" })).toBeNull();
    view.unmount();
    cleanup();

    (window as unknown as { studyclawDesktop?: unknown }).studyclawDesktop = { isDesktop: true, openDataDir };
    render(<DataSection />);
    fireEvent.click(screen.getByRole("button", { name: "打开数据目录" }));
    await waitFor(() => expect(openDataDir).toHaveBeenCalled());
  });

  it("文案声明导出物不含凭据", () => {
    render(<DataSection />);
    expect(screen.getByText(/不含任何凭据/)).toBeDefined();
  });
});