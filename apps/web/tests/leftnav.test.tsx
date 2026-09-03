import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { storeState, selectSession, createSession, renameSession, forkSession, archiveSession, reorderSession, flashBanner, apiMocks, wsActions, suppressAutoSelect } = vi.hoisted(() => ({
  storeState: {
    courses: [
      {
        id: "course-1",
        title: "Kubernetes",
        overallMastery: 0,
        dueToday: 0,
        lastActiveAt: "2026-08-20T00:00:00Z",
      },
    ],
    activeCourseId: "course-1",
    courseSessions: {
      "course-1": [
        {
          sessionId: "session-1",
          title: "调度基础",
          mode: "socratic",
          turns: 1,
          createdAt: "2026-08-20T00:00:00Z",
          lastActiveAt: "2026-08-20T00:00:00Z",
        },
      ],
    },
    sessions: [],
    activeSessionId: "session-1",
    syncState: "synced",
    buildStatus: "idle",
    wizardOpen: false,
    workspacePath: "D:/learn/ws-alpha",
    setWizardOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
    setActiveCourse: vi.fn(),
    flashStatusBanner: vi.fn(),
  },
  selectSession: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  archiveSession: vi.fn(),
  reorderSession: vi.fn(),
  flashBanner: vi.fn(),
  apiMocks: {
    workspaces: vi.fn(),
    workspaceCourses: vi.fn(),
    removeWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    reorderWorkspace: vi.fn(),
    searchSessions: vi.fn(),
  },
  wsActions: {
    adoptWorkspace: vi.fn(),
    monitorBuildJob: vi.fn(),
  },
  suppressAutoSelect: vi.fn(),
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/hooks/useSessionActions", () => ({
  useSessionActions: () => ({ selectSession, createSession, renameSession, forkSession, archiveSession, reorderSession }),
  // UI-9：跨项目选会话时抑制自动选会话的导出。
  suppressAutoSelectOnce: suppressAutoSelect,
}));
vi.mock("../src/components/left/NewProjectWizard", () => ({ default: () => null }));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));
vi.mock("../src/lib/workspaceActions", () => ({ adoptWorkspace: wsActions.adoptWorkspace, monitorBuildJob: wsActions.monitorBuildJob }));

import LeftNav from "../src/components/left/LeftNav";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState.courses = storeState.courses.filter((course) => course.id === "course-1");
  storeState.courseSessions["course-1"] = [
    {
      sessionId: "session-1",
      title: "调度基础",
      mode: "socratic",
      turns: 1,
      createdAt: "2026-08-20T00:00:00Z",
      lastActiveAt: "2026-08-20T00:00:00Z",
    },
  ];
});

const workspaceItems = [
  {
    id: "ws-a1",
    path: "D:/learn/ws-alpha",
    title: "ws-alpha",
    createdAt: "2026-08-21T10:00:00Z",
    updatedAt: "2026-08-21T10:00:00Z",
  },
  {
    id: "ws-b2",
    path: "D:/learn/ws-beta",
    title: "ws-beta",
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-21T09:00:00Z",
  },
];

function mockWorkspaces(items = workspaceItems) {
  apiMocks.workspaces.mockResolvedValue({ current: "D:/learn/ws-alpha", items });
  apiMocks.workspaceCourses.mockResolvedValue({ courses: [], missing: false });
  apiMocks.searchSessions.mockResolvedValue({ items: [], hasMore: false });
}

describe("LeftNav search state", () => {
  it("对齐 dsh：折叠栏搜索先展开，再在栏宽动画后聚焦", () => {
    vi.useFakeTimers();
    try {
      const onExpand = vi.fn();
      const { rerender } = render(<LeftNav collapsed onExpand={onExpand} />);

      fireEvent.click(screen.getByRole("button", { name: "搜索项目和对话" }));
      expect(onExpand).toHaveBeenCalledTimes(1);

      rerender(<LeftNav collapsed={false} onExpand={onExpand} />);
      const input = screen.getByPlaceholderText("搜索项目或对话");
      expect(input).not.toHaveFocus();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(input).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on outside click, Escape, and keeps the query for the next open", () => {
    const { unmount } = render(<LeftNav />);
    const searchButton = screen.getByRole("button", { name: "搜索项目和对话" });
    const input = screen.getByPlaceholderText("搜索项目或对话");

    fireEvent.click(searchButton);
    fireEvent.change(input, { target: { value: "调度" } });
    expect(input).toHaveAttribute("tabindex", "0");
    fireEvent.pointerDown(document.body);
    expect(input).toHaveAttribute("tabindex", "-1");

    fireEvent.click(searchButton);
    expect(input).toHaveValue("调度");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(input).toHaveAttribute("tabindex", "-1");
    unmount();
  });

  it("对齐 dsh：去抖搜索全部项目的 JSONL 内容，并能打开命中对话", async () => {
    mockWorkspaces();
    apiMocks.searchSessions.mockResolvedValue({
      items: [{
        sessionId: "session-remote",
        title: "多态复习",
        mode: "socratic",
        turns: 2,
        createdAt: "2026-08-20T00:00:00Z",
        lastActiveAt: "2026-08-20T00:01:00Z",
        workspacePath: "D:/learn/ws-beta",
        workspaceTitle: "ws-beta",
        courseId: "course-remote",
        courseTitle: "Java",
        snippet: "覆写会在运行时替换父类行为。",
      }],
      hasMore: true,
    });
    wsActions.adoptWorkspace.mockResolvedValue({ workspace: workspaceItems[1], created: false });
    render(<LeftNav />);

    fireEvent.click(screen.getByRole("button", { name: "搜索项目和对话" }));
    fireEvent.change(screen.getByPlaceholderText("搜索项目或对话"), { target: { value: "覆写" } });

    expect(screen.getByRole("status")).toHaveTextContent("正在搜索对话");
    await waitFor(() => expect(apiMocks.searchSessions).toHaveBeenCalledWith("覆写", expect.any(AbortSignal)));
    expect(await screen.findByText("多态复习")).toBeInTheDocument();
    expect(screen.getByText("覆写会在运行时替换父类行为。")).toBeInTheDocument();
    expect(screen.getByText("仅显示前 50 个结果，请继续细化关键词")).toBeInTheDocument();

    fireEvent.click(screen.getByText("多态复习"));
    await waitFor(() => expect(wsActions.adoptWorkspace).toHaveBeenCalledWith("D:/learn/ws-beta"));
    expect(storeState.setActiveCourse).toHaveBeenCalledWith("course-remote");
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith("session-remote", "course-remote"));
  });
});

describe("LeftNav 项目切换器", () => {
  it("品牌行显示当前项目名，菜单列出项目并标记当前项", async () => {
    mockWorkspaces();
    render(<LeftNav />);

    expect(screen.getByRole("button", { name: "切换项目" })).toHaveTextContent("ws-alpha");
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));

    const menu = await screen.findByRole("menu");
    expect(apiMocks.workspaces).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitemradio", { name: /ws-alpha/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /ws-beta/ })).toHaveAttribute("aria-checked", "false");
    expect(menu).toHaveTextContent("D:/learn/ws-beta");
  });

  it("点击其他项目即接管切换并横幅确认", async () => {
    mockWorkspaces();
    wsActions.adoptWorkspace.mockResolvedValue({ workspace: workspaceItems[1], created: false });
    render(<LeftNav />);

    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /ws-beta/ }));

    await waitFor(() => expect(wsActions.adoptWorkspace).toHaveBeenCalledWith("D:/learn/ws-beta"));
    expect(storeState.flashStatusBanner).toHaveBeenCalledWith("已切换到 ws-beta");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("移除只忘记录：确认框后按 id 调用 removeWorkspace 并刷新列表", async () => {
    mockWorkspaces();
    apiMocks.removeWorkspace.mockResolvedValue({ items: [workspaceItems[0]] });
    render(<LeftNav />);

    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    // 组件的 aria-label 是「移除项目 <title>」，且移除必须先过确认框
    //（磁盘数据不删除）——旧用例断言的旧 label + 无确认框均已漂移。
    fireEvent.click(await screen.findByRole("button", { name: "移除项目 ws-beta" }));
    const dialog = await screen.findByRole("dialog", { name: "确认移除项目" });
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));

    await waitFor(() => expect(apiMocks.removeWorkspace).toHaveBeenCalledWith("ws-b2"));
    expect(screen.queryByRole("menuitemradio", { name: /ws-beta/ })).not.toBeInTheDocument();
  });
});

describe("LeftNav 多项目并列显示", () => {
  it("同时渲染所有项目及其课程（导入不覆盖）", async () => {
    mockWorkspaces();
    apiMocks.workspaceCourses.mockImplementation((path: string) =>
      Promise.resolve({
        courses: path === "D:/learn/ws-beta" ? [{
          id: "b-course",
          title: "Beta 课程",
          overallMastery: 0,
          dueToday: 2,
          lastActiveAt: null,
        }] : [],
        missing: false,
      }),
    );
    render(<LeftNav />);

    expect(await screen.findByText("Beta 课程")).toBeInTheDocument();
    // 品牌行与树头各出现一次：两个项目并列在册。
    expect(screen.queryAllByText("ws-alpha").length).toBeGreaterThanOrEqual(1);
    // 非当前项目行标题=课程标题，路径在 title 提示中（通过 Beta 课程即证）。
    expect(screen.getByTitle(/D:\/learn\/ws-beta/)).toBeInTheDocument();
    expect(apiMocks.workspaceCourses).toHaveBeenCalledWith("D:/learn/ws-alpha");
    expect(apiMocks.workspaceCourses).toHaveBeenCalledWith("D:/learn/ws-beta");
  });

  it("点击非当前项目的课程：先接管项目再选中该课程", async () => {
    mockWorkspaces();
    apiMocks.workspaceCourses.mockResolvedValue({
      courses: [{ id: "b-course", title: "Beta 课程", overallMastery: 0, dueToday: 0, lastActiveAt: null }],
      missing: false,
    });
    wsActions.adoptWorkspace.mockResolvedValue({ workspace: workspaceItems[1], created: false });
    render(<LeftNav />);

    fireEvent.click(await screen.findByText("Beta 课程"));

    await waitFor(() => expect(wsActions.adoptWorkspace).toHaveBeenCalledWith("D:/learn/ws-beta"));
  });

  it("行内重命名：实时标红重名冲突，Enter 提交", async () => {
    mockWorkspaces();
    apiMocks.renameWorkspace.mockResolvedValue({ workspace: { ...workspaceItems[1], title: "ws-alpha" } });
    render(<LeftNav />);

    const renameButton = await screen.findByRole("button", { name: "重命名 ws-beta" });
    fireEvent.click(renameButton);
    const input = screen.getByRole("textbox", { name: "项目名称" });

    fireEvent.change(input, { target: { value: "ws-alpha" } });
    expect(input).toHaveClass("border-red-500");

    fireEvent.change(input, { target: { value: "ws-gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(apiMocks.renameWorkspace).toHaveBeenCalledWith("ws-b2", "ws-gamma"));
  });
});

describe("LeftNav 对话操作", () => {
  it("对齐 dsh：菜单提供重命名、创建副本、归档和复制标题", async () => {
    mockWorkspaces();
    apiMocks.workspaceCourses.mockResolvedValue({
      courses: [{ id: "course-1", title: "Kubernetes", overallMastery: 0, dueToday: 0, lastActiveAt: null }],
      missing: false,
    });
    renameSession.mockResolvedValue({ sessionId: "session-1", title: "新标题" });
    forkSession.mockResolvedValue({ sessionId: "session-2", file: "session-2.jsonl" });
    archiveSession.mockResolvedValue({ sessionId: "session-1", archived: true });
    render(<LeftNav />);

    const action = await screen.findByRole("button", { name: "对话操作", hidden: true });
    fireEvent.mouseEnter(action);
    fireEvent.click(action);
    expect(screen.getByRole("menu")).toHaveTextContent("重命名");
    expect(screen.getByRole("menu")).toHaveTextContent("创建副本");
    expect(screen.getByRole("menu")).toHaveTextContent("归档");
    expect(screen.getByRole("menu")).toHaveTextContent("复制标题");

    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "对话名称" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(renameSession).toHaveBeenCalledWith("session-1", "新标题", "course-1"));
  });

  it("对齐 dsh：同一课程的对话拖拽会持久化插入顺序", async () => {
    storeState.courseSessions["course-1"] = [
      {
        sessionId: "session-1",
        title: "调度基础",
        mode: "socratic",
        turns: 1,
        createdAt: "2026-08-20T00:00:00Z",
        lastActiveAt: "2026-08-20T00:00:00Z",
      },
      {
        sessionId: "session-2",
        title: "网络基础",
        mode: "socratic",
        turns: 1,
        createdAt: "2026-08-20T00:01:00Z",
        lastActiveAt: "2026-08-20T00:01:00Z",
      },
    ];
    mockWorkspaces();
    reorderSession.mockResolvedValue([storeState.courseSessions["course-1"][1], storeState.courseSessions["course-1"][0]]);
    render(<LeftNav />);

    const source = await screen.findByText("调度基础");
    const target = screen.getByText("网络基础");
    const sourceRow = source.closest('[role="treeitem"]');
    const targetRow = target.closest('[role="treeitem"]');
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    expect(sourceRow).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(sourceRow!, { dataTransfer });
    await waitFor(() => expect(dataTransfer.setData).toHaveBeenCalled());
    fireEvent.drop(targetRow!, { dataTransfer });

    await waitFor(() => expect(reorderSession).toHaveBeenCalledWith("session-1", "session-2", "course-1"));
  });

  it("当前项目行内新开对话：作用于该项目", async () => {
    mockWorkspaces();
    apiMocks.workspaceCourses.mockResolvedValue({
      courses: [{ id: "course-1", title: "Kubernetes", overallMastery: 0, dueToday: 0, lastActiveAt: null }],
      missing: false,
    });
    render(<LeftNav />);

    fireEvent.click(await screen.findByRole("button", { name: "在 Kubernetes 新开对话" }));

    expect(createSession).toHaveBeenCalledWith(undefined, "course-1");
  });
});
