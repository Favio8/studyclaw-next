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
      setActiveCourse: vi.fn(),
      setBuildStatus: vi.fn(),
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
