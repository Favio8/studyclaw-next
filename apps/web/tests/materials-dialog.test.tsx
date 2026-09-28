import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => {
  class MockApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    storeState: {
      activeCourseId: "course-1",
      courses: [{ id: "course-1", title: "Java OOP" }],
      setActiveCourse: vi.fn(),
      setBuildStatus: vi.fn(),
      setLastImport: vi.fn(),
      flashStatusBanner: vi.fn(),
      setCourses: vi.fn(),
      // 爪爪 uploading 态输入源（P1）：测试内不关心调用
      setUploading: vi.fn(),
    },
    apiMocks: {
      ApiError: MockApiError,
      uploadSources: vi.fn(),
      workspaceFiles: vi.fn(),
      initWorkspace: vi.fn(),
      job: vi.fn(),
      courseList: vi.fn(),
      progress: vi.fn(),
      mastery: vi.fn(),
      heatmap: vi.fn(),
    },
  };
});

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({
  ApiError: apiMocks.ApiError,
  api: apiMocks,
}));
vi.mock("../src/lib/panelData", () => ({
  refreshCourseList: vi.fn(() => Promise.resolve()),
  refreshPanelData: vi.fn(() => Promise.resolve()),
}));

import { ApiError } from "../src/lib/api";
import { refreshCourseList, refreshPanelData } from "../src/lib/panelData";
import MaterialsDialog from "../src/components/left/MaterialsDialog";

vi.mocked(refreshCourseList).mockResolvedValue(undefined);
vi.mocked(refreshPanelData).mockResolvedValue(undefined);

function file(name: string): File {
  return new File(["content"], name, { type: "text/plain" });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MaterialsDialog 上传补充", () => {
  it("选择文件后调用 uploadSources 并反馈归档名与重名序号", async () => {
    apiMocks.uploadSources.mockResolvedValue({
      added: ["guide.md", "guide_2.md"],
      buildJobId: "job_1",
    });
    apiMocks.job.mockResolvedValue({ status: "done", result: { tasksGenerated: 4 } });

    const onClose = vi.fn();
    render(<MaterialsDialog onClose={onClose} />);

    const input = screen.getByLabelText("点击选择本地资料（可多选，md/txt/pdf/docx/xlsx/html）");
    fireEvent.change(input, { target: { files: [file("guide.md"), file("guide.md")] } });

    fireEvent.click(screen.getByRole("button", { name: /上传并构建/ }));

    // jsdom File 无自有可枚举属性（name 是原型 getter），toHaveBeenCalledWith
    // 的结构深比较对任意两个 File 都判相等——不能比较 File 对象本身，必须
    // 断言实际收到的文件名（错误文件名/顺序颠倒在此现形）。
    await waitFor(() => {
      expect(apiMocks.uploadSources).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.uploadSources.mock.calls[0]?.[0]).toBe("course-1");
    expect((apiMocks.uploadSources.mock.calls[0]?.[1] as File[]).map((f) => f.name)).toEqual([
      "guide.md",
      "guide.md",
    ]);
    await waitFor(() => {
      expect(screen.getByText(/guide_2\.md/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(storeState.setBuildStatus).toHaveBeenCalledWith("running");
      expect(storeState.setBuildStatus).toHaveBeenCalledWith("done");
    });
    await waitFor(() => {
      expect(refreshPanelData).toHaveBeenCalled();
      expect(refreshCourseList).toHaveBeenCalled();
    });
  });

  it("W-9：未配置模型（buildJobId=null）时明确告知未启动构建", async () => {
    apiMocks.uploadSources.mockResolvedValue({
      added: ["guide.md"],
      buildJobId: null,
    });
    render(<MaterialsDialog onClose={vi.fn()} />);

    const input = screen.getByLabelText("点击选择本地资料（可多选，md/txt/pdf/docx/xlsx/html）");
    fireEvent.change(input, { target: { files: [file("guide.md")] } });
    fireEvent.click(screen.getByRole("button", { name: /上传并构建/ }));

    await waitFor(() => {
      expect(screen.getByText(/尚未配置模型/)).toBeInTheDocument();
    });
    // 不得谎称"后台开始构建"。
    expect(screen.queryByText(/后台开始构建课程索引/)).not.toBeInTheDocument();
  });

  it("inplace 课程拒绝上传：INPLACE_SOURCE_BOUND 错误原样呈现", async () => {
    apiMocks.uploadSources.mockRejectedValue(
      new ApiError("INPLACE_SOURCE_BOUND", "当前项目直接扫描所选目录；请把补充资料放入该目录后执行同步", 409),
    );
    render(<MaterialsDialog onClose={vi.fn()} />);

    const input = screen.getByLabelText("点击选择本地资料（可多选，md/txt/pdf/docx/xlsx/html）");
    fireEvent.change(input, { target: { files: [file("x.md")] } });
    fireEvent.click(screen.getByRole("button", { name: /上传并构建/ }));

    await waitFor(() => {
      expect(screen.getByText(/INPLACE_SOURCE_BOUND/)).toBeInTheDocument();
    });
    expect(storeState.flashStatusBanner).toHaveBeenCalled();
  });

  it("未选文件时上传按钮禁用，选中后启用", async () => {
    render(<MaterialsDialog onClose={vi.fn()} />);
    const submit = screen.getByRole("button", { name: /上传并构建/ });
    expect(submit).toBeDisabled();

    const input = screen.getByLabelText("点击选择本地资料（可多选，md/txt/pdf/docx/xlsx/html）");
    fireEvent.change(input, { target: { files: [file("a.md")] } });
    expect(screen.getByRole("button", { name: /上传并构建/ })).toBeEnabled();
    expect(apiMocks.uploadSources).not.toHaveBeenCalled();
  });

  it("上传目标显示课程标题而非 UUID（标题缺失时回落 id）", async () => {
    render(<MaterialsDialog onClose={vi.fn()} />);
    // 默认 tab 即上传补充：说明文案带标题、不带 UUID。
    expect(screen.getByText(/上传到当前课程：Java OOP/)).toBeInTheDocument();
    expect(screen.queryByText(/course-1/)).not.toBeInTheDocument();

    // 课程列表还没加载到时（标题取不到）回落到 id，不显示 undefined。
    storeState.courses = [];
    render(<MaterialsDialog onClose={vi.fn()} />);
    expect(screen.getByText(/上传到当前课程：course-1/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    storeState.courses = [{ id: "course-1", title: "Java OOP" }];
  });

  it("initialTab=import 时直接落在勾选新建课程页", async () => {
    apiMocks.workspaceFiles.mockResolvedValue({ root: "D:/ws", files: [] });
    render(<MaterialsDialog initialTab="import" onClose={vi.fn()} />);
    // 上传页的说明不该出现，勾选页的枚举提示该出现。
    await waitFor(() => expect(screen.getByText(/正在枚举项目候选资料/)).toBeInTheDocument());
    expect(screen.queryByText(/上传到当前课程/)).not.toBeInTheDocument();
  });
});

describe("MaterialsDialog 勾选新建课程", () => {
  it("列出工作区候选并勾选导入创建课程", async () => {
    apiMocks.workspaceFiles.mockResolvedValue({
      root: "D:/ws",
      files: [
        { name: "a.md", path: "D:/ws/a.md", relative: "a.md", size: 10, mtime: "2026-08-20T00:00:00Z", supported: true },
        { name: "b.txt", path: "D:/ws/b.txt", relative: "b.txt", size: 20, mtime: "2026-08-20T00:00:00Z", supported: true },
        { name: "c.pdf", path: "D:/ws/c.pdf", relative: "c.pdf", size: 30, mtime: "2026-08-20T00:00:00Z", supported: true },
        { name: "x.exe", path: "D:/ws/x.exe", relative: "x.exe", size: 40, mtime: "2026-08-20T00:00:00Z", supported: false },
      ],
    });
    apiMocks.initWorkspace.mockResolvedValue({
      workspace: "D:/ws",
      course: "k8s",
      ingestedFiles: 2,
      buildJobId: "job_2",
    });
    apiMocks.job.mockResolvedValue({ status: "done", result: { tasksGenerated: 4 } });
    apiMocks.courseList.mockResolvedValue({ courses: [{ id: "k8s", title: "k8s" }] });

    render(<MaterialsDialog onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /勾选新建课程/ }));

    await waitFor(() => {
      expect(apiMocks.workspaceFiles).toHaveBeenCalled();
    });

    // 勾选两份可摄取资料（x.exe 不可勾选）
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]); // a.md
    fireEvent.click(checkboxes[1]); // b.txt
    fireEvent.change(screen.getByPlaceholderText("k8s-internals"), { target: { value: "k8s" } });

    fireEvent.click(screen.getByRole("button", { name: /勾选并创建课程/ }));

    await waitFor(() => {
      expect(apiMocks.initWorkspace).toHaveBeenCalledWith({
        mode: "create",
        courseName: "k8s",
        importPaths: ["D:/ws/a.md", "D:/ws/b.txt"],
        deferBuild: false,
      });
    });
    await waitFor(() => {
      expect(storeState.setActiveCourse).toHaveBeenCalledWith("k8s");
      expect(storeState.setBuildStatus).toHaveBeenCalledWith("running");
    });
    await waitFor(() => {
      expect(storeState.setBuildStatus).toHaveBeenCalledWith("done");
    });
  });
});

describe("MaterialsDialog 焦点管理（W-10）", () => {
  it("打开后焦点落在弹层内（首个可聚焦控件），而非逃逸到背景", () => {
    render(<MaterialsDialog onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "资料" });
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(dialog.contains(active)).toBe(true);
  });

  it("Escape 关闭弹层（与遮罩点击同语义）", () => {
    const onClose = vi.fn();
    render(<MaterialsDialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);  });
});

