"use client";

/**
 * 三栏控制台外壳（v1.4：DSH ui-layout AppFrame 复刻）。
 *
 * - CSS Grid `<sidebar>px minmax(0,1fr) <details>px`：左栏默认 280（拖拽
 *   264~420），右栏默认 360（拖拽 300~520）；轨道过渡 300ms，拖拽中禁用；
 * - 无全局 titlebar（DSH 语义）：品牌/同步灯在左栏 logoRow，面包屑在
 *   中栏 ChatArea 头部，模式切换在输入卡工具行；
 * - 拖把手 8px 热区（DSH：左栏纯热区，右栏 hover 显 12×32 胶囊）。
 */

import { useCallback, useEffect, useState } from "react";
import ChatArea from "@/src/components/chat/ChatArea";
import LeftNav from "@/src/components/left/LeftNav";
import RightPanel from "@/src/components/panel/RightPanel";
import CommandPalette from "@/src/components/palette/CommandPalette";
import SettingsDialog from "@/src/components/settings/SettingsDialog";
import { useKeyboardShortcuts } from "@/src/hooks/useKeyboardShortcuts";
import { usePanelData } from "@/src/hooks/usePanelData";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";

/** DSH columns.ts：SIDEBAR_MIN/MAX/DEFAULT 与 DETAILS_MIN/MAX/DEFAULT。 */
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_COLLAPSED = 56;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
const DETAILS_DEFAULT = 360;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function Console() {
  const setCourses = useAppStore((s) => s.setCourses);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const setMode = useAppStore((s) => s.setMode);
  const setCourseSessions = useAppStore((s) => s.setCourseSessions);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  usePanelData(); // 右栏：progress/mastery/heatmap 随激活项目刷新（T3.2）
  useKeyboardShortcuts(); // 全局快捷键（T3.4+T3.5）

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
  const effectiveSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth;
  const [dragging, setDragging] = useState<null | "sidebar" | "details">(null);

  const loadCourses = useCallback(async () => {
    try {
      const workspacePath = useAppStore.getState().workspacePath;
      if (!workspacePath) return;
      const { courses: list } = await api.courseList(workspacePath);
      setCourses(list);
      void Promise.all(
        list.map(async (course) => {
          try {
            const { sessions } = await api.sessions(course.id);
            setCourseSessions(course.id, sessions);
          } catch {
            // 项目树允许单个项目会话读取失败，激活项目仍会由 hook 重试。
          }
        }),
      );
      return list;
    } catch {
      return [];
    }
  }, [setCourses, setCourseSessions]);

  useEffect(() => {
    void api.settings().then((payload) => setMode(payload.ui.defaultMode)).catch(() => {
      // The controls remain usable when an older backend has no settings route.
    });
    void api.workspaces().then((payload) => {
      useAppStore.getState().setWorkspacePath(payload.current);
    }).catch(() => {
      // 切换器显示退化为「StudyClaw」，不影响课程列表。
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMode]);

  // 工作区指针就绪/切换后重拉课程（M1 起课程列表按工作区读取，存在异步竞态：
  // loadCourses 在 workspaces() 返回前执行会拿不到 path 而空跑）。
  const workspacePath = useAppStore((s) => s.workspacePath);
  useEffect(() => {
    if (!workspacePath) return;
    void loadCourses().then(async (list) => {
      if (list && list.length > 0) {
        setActiveCourse(list[0].id); // 默认激活第一个项目
      } else {
        // 骨架自愈（DSH：工作区随时可开聊）：课程记录缺失时补空骨架（无 LLM）。
        const courseId = workspacePath.split(/[\/]/).pop() ?? "";
        if (courseId) {
          try {
            await api.ensureCourse(courseId);
            const again = await loadCourses();
            if (again && again.length > 0) setActiveCourse(again[0].id);
          } catch {
            /* 保持空态 */
          }
        }
      }
    });
  }, [workspacePath, loadCourses, setActiveCourse]);

  // DSH: 视口 <1024px 时左侧栏自动折叠为 56px rail（columns.ts SIDEBAR_AUTO_COLLAPSE）
  useEffect(() => {
    const onResize = () => setSidebarCollapsed(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

    /** DSH AppFrame：pointer capture + 拖拽基点取起始实际宽度，防跳变。 */
  const startDrag = useCallback(
    (side: "sidebar" | "details") =>
      (event: React.PointerEvent) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = side === "sidebar" ? sidebarWidth : detailsWidth;
        setDragging(side);
        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          if (side === "sidebar") {
            setSidebarWidth(clamp(startWidth + dx, SIDEBAR_MIN, SIDEBAR_MAX));
          } else {
            setDetailsWidth(clamp(startWidth - dx, DETAILS_MIN, DETAILS_MAX));
          }
        };
        const onUp = () => {
          setDragging(null);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
    [sidebarWidth, detailsWidth],
  );

  return (
    <div
      data-dragging={dragging ? "" : undefined}
      className="relative grid h-screen overflow-hidden bg-bg-panel transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] data-[dragging]:transition-none"
      style={{
        gridTemplateColumns: `${effectiveSidebarWidth}px minmax(0, 1fr) ${detailsWidth}px`,
      }}
    >
      {/* 左栏：sidebar-fill 底 + l1 hairline 右边线（DSH sidebarCol） */}
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border-faint bg-bg-root">
        <LeftNav collapsed={sidebarCollapsed} onExpand={() => setSidebarCollapsed(false)} onCollapse={() => setSidebarCollapsed(true)} />
      </aside>

      {/* 中栏：白底，无右边线（右栏自带 border-l，DSH 同） */}
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-panel">
        <ChatArea />
      </main>

      {/* 右栏：l2 hairline 左边线（DSH detailsCol） */}
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border-line">
        <RightPanel />
      </section>

      {/* 拖拽把手：8px 热区跨在列边界上（DSH handle） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        onPointerDown={sidebarCollapsed ? undefined : startDrag("sidebar")}
        className={`group absolute bottom-0 top-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none ${sidebarCollapsed ? "hidden" : ""}`}
        style={{ left: effectiveSidebarWidth }}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        onPointerDown={startDrag("details")}
        className="group absolute bottom-0 top-0 z-10 w-2 translate-x-1/2 cursor-col-resize touch-none"
        style={{ left: `calc(100% - ${detailsWidth}px)` }}
      >
        {/* hover 胶囊（DSH：12×32 圆条，白底 l2 边） */}
        <span className="pointer-events-none absolute top-1/2 left-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[10px] border border-border-line bg-bg-panel opacity-0 shadow-lv2 transition-opacity duration-150 group-hover:opacity-100" />
      </div>

      {/* 弹层（卸载式渲染，T3.5） */}
      {paletteOpen && <CommandPalette />}
      {settingsOpen && <SettingsDialog />}
    </div>
  );
}
