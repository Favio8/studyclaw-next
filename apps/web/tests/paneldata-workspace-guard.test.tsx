/**
 * W-6 回归：refreshCourseList 落地前必须校验 workspacePath——chat sync/done
 * 触发的课程列表刷新与用户切项目竞态时，旧工作区的 courses 晚到会覆盖新工作区
 * 且不自愈（Console effect 已先跑完）。与 runPanelRefresh 的课程守卫同口径。
 */

import { describe, expect, it, vi } from "vitest";

const { storeState, apiMocks } = vi.hoisted(() => ({
  storeState: {
    workspacePath: "/ws/old" as string | null,
    setCourses: vi.fn(),
    flashStatusBanner: vi.fn(),
  },
  apiMocks: {
    courseList: vi.fn(),
  },
}));

vi.mock("../src/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../src/lib/api", () => ({ api: apiMocks }));

import { refreshCourseList } from "../src/lib/panelData";

describe("refreshCourseList 切工作区守卫（W-6）", () => {
  it("await 期间切工作区：旧工作区 courses 不覆盖新工作区", async () => {
    storeState.setCourses.mockClear();
    let resolveList!: (value: { courses: unknown[] }) => void;
    apiMocks.courseList.mockReturnValue(new Promise(resolve => { resolveList = resolve }));
    const pending = refreshCourseList();
    // 拉取在途时用户切到新工作区。
    storeState.workspacePath = "/ws/new";
    resolveList({ courses: [{ id: "old-course" }] });
    await pending;
    expect(storeState.setCourses).not.toHaveBeenCalled();
    storeState.workspacePath = "/ws/old";
  });

  it("未切工作区：课程列表正常落地", async () => {
    storeState.setCourses.mockClear();
    apiMocks.courseList.mockResolvedValue({ courses: [{ id: "c1" }] });
    await refreshCourseList();
    expect(storeState.setCourses).toHaveBeenCalledWith([{ id: "c1" }]);
  });
});
