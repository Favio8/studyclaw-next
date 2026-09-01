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

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
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
  // FL-22：宿主心跳。旧版 api.workspaces() 失败被静默吞掉且"左栏错误横幅"
  // 根本不存在——用户只起了 next dev 忘了起 studyclaw serve 时，三栏空壳、
  // 零报错零引导，30 秒内判定"这软件是坏的"。null = 探测中。
  const [hostUp, setHostUp] = useState<boolean | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        await api.health();
        if (!cancelled) setHostUp(true);
      } catch {
        if (!cancelled) setHostUp(false);
      }
    };
    void probe();
    heartbeatTimer.current = setInterval(() => void probe(), 8000);
    return () => {
      cancelled = true;
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
  }, []);

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
            // 项目树允许单个项目对话读取失败，激活项目仍会由 hook 重试。
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
    // 服务端注册表是唯一事实源（dsh 语义）：无 current 即空态首启，不再用
    // localStorage 旧路径做幽灵恢复——那会把 e2e/历史路径变成"占位项目"。
    void api.workspaces().then((payload) => {
      if (payload.current) {
        useAppStore.getState().setWorkspacePath(payload.current);
      }
    }).catch(() => {
      /* 后端不可达：保持空态，左栏错误横幅自会提示 */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMode]);

  // 项目指针就绪/切换后重拉课程（M1 起课程列表按项目读取，存在异步竞态：
  // loadCourses 在 workspaces() 返回前执行会拿不到 path 而空跑）。
  const workspacePath = useAppStore((s) => s.workspacePath);
  useEffect(() => {
    if (!workspacePath) return;
    void loadCourses().then(async (list) => {
      if (list && list.length > 0) {
        setActiveCourse(list[0].id); // 默认激活第一个项目
        return;
      }
      // 骨架自愈（DSH：工作区随时可开聊）：课程记录缺失（如清场后）时补空
      // 骨架——不触发 LLM——然后重拉列表，恢复「新对话」可用。
      // FL-23：工作区路径是 `realpath` 的规范路径（paths.ts:19-21 只做 realpath，
      // 不做分隔符转换）——Windows 上是 `D:\a\b`，POSIX 上是 `/a/b`。旧实现只按 `/`
      // 切分，在 Windows 上 `pop()` 会拿到整条路径而非末段，随后被 courseDirOf 的
      // basename 校验拒绝（course.ts:64-65）并被下面的 catch 静默吞掉，导致"新对话"
      // 永远不可用。两种分隔符都要切。
      const courseId = workspacePath.split(/[\\/]/).pop() ?? "";
      if (!courseId) return;
      try {
        await api.ensureCourse(courseId);
        const again = await loadCourses();
        if (again && again.length > 0) setActiveCourse(again[0].id);
      } catch {
        /* 后端不可达/课程不允许：保持空态，由用户手动打开项目 */
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

      {/* FL-22：后端未启动横幅（8s 心跳持续探测，恢复后自动消失） */}
      {hostUp === false ? (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-[13px] text-red-700"
        >
          <CircleAlert size={15} strokeWidth={1.8} aria-hidden />
          <span>
            后端未启动：请在终端运行{" "}
            <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[12px]">studyclaw serve</code>
            （默认 127.0.0.1:8080），启动后本横幅会自动消失。
          </span>
        </div>
      ) : null}


      {/* 弹层（卸载式渲染，T3.5） */}
      {paletteOpen && <CommandPalette />}
      {settingsOpen && <SettingsDialog />}
    </div>
  );
}
