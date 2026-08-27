"use client";

/**
 * 左栏项目/会话树。
 *
 * 几何直接对齐 DSH ui-sidebar + ui-workspace：60px 品牌行、38px 新会话、
 * 36px 树标题/可展开搜索、34px 项目行、32px 会话行。会话按项目缓存，避免
 * 把当前项目的会话误投影到其他项目分组中。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import MaterialsDialog from "@/src/components/left/MaterialsDialog";
import NewProjectWizard from "@/src/components/left/NewProjectWizard";
import { useSessionActions } from "@/src/hooks/useSessionActions";
import { api } from "@/src/lib/api";
import { relativeTime } from "@/src/lib/format";
import { adoptWorkspace } from "@/src/lib/workspaceActions";
import { useAppStore } from "@/src/store/useAppStore";
import type { CourseSummary, SessionSearchResult, SessionSummary, WorkspaceItem } from "@/src/types/api";

const SESSION_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 250;
// Keep focus out of the 300ms sidebar slide so opening rail search does not jank.
const EXPAND_SLIDE_MS = 300;

type WorkspaceGroupMode = "workspace" | "flat";
type WorkspaceOrderMode = "manual" | "updated";
type RemoteSearchState = {
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  items: SessionSearchResult[];
  hasMore: boolean;
};

const iconProps = { size: 16, strokeWidth: 1.8 } as const;

function SearchGlyph() {
  return <Search {...iconProps} aria-hidden />;
}

function ViewGlyph() {
  return <SlidersHorizontal {...iconProps} aria-hidden />;
}

function WorkspaceAddGlyph() {
  return <FolderPlus {...iconProps} aria-hidden />;
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

function sortedVisibleSessions(
  sessions: SessionSummary[],
  activeSessionId: string | null,
  orderBy: WorkspaceOrderMode,
): SessionSummary[] {
  const visible = [...sessions].filter(
    (session) => session.turns > 0 || session.sessionId === activeSessionId,
  );
  if (orderBy === "manual") return visible;
  return visible.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
  );
}

function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll("\0", "");
  if (withoutNul.length <= 500) return withoutNul;
  let end = 500;
  const last = withoutNul.charCodeAt(end - 1);
  const next = withoutNul.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return withoutNul.slice(0, end);
}

function sessionMenuKey(courseId: string, sessionId: string): string {
  return `${courseId}:${sessionId}`;
}

function moveSessionBefore(
  sessions: SessionSummary[],
  sessionId: string,
  beforeId?: string,
): SessionSummary[] {
  const source = sessions.find((session) => session.sessionId === sessionId);
  if (!source || beforeId === sessionId) return sessions;
  const remaining = sessions.filter((session) => session.sessionId !== sessionId);
  const insertAt = beforeId === undefined
    ? remaining.length
    : remaining.findIndex((session) => session.sessionId === beforeId);
  if (insertAt < 0) return sessions;
  return [...remaining.slice(0, insertAt), source, ...remaining.slice(insertAt)];
}

export function WorkspaceViewOptions({
  groupBy,
  orderBy,
  onGroupBy,
  onOrderBy,
}: {
  groupBy: WorkspaceGroupMode;
  orderBy: WorkspaceOrderMode;
  onGroupBy: (value: WorkspaceGroupMode) => void;
  onOrderBy: (value: WorkspaceOrderMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(action: () => void) {
    action();
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="工作区显示选项"
        aria-expanded={open}
        title="工作区显示选项"
        className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        onClick={() => setOpen((value) => !value)}
      >
        <ViewGlyph />
      </button>
      {open ? (
        <div role="menu" className="absolute top-8 right-0 z-30 w-44 rounded-xl border border-border-line bg-bg-panel p-1.5 shadow-lv3">
          <div className="px-2 py-1 text-[11px] text-text-faint">分组方式</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={groupBy === "workspace"}
            className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            onClick={() => choose(() => onGroupBy("workspace"))}
          >
            <span>按工作区</span>{groupBy === "workspace" ? <Check size={14} strokeWidth={2} className="text-accent-focus" aria-hidden /> : null}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={groupBy === "flat"}
            className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            onClick={() => choose(() => onGroupBy("flat"))}
          >
            <span>单列表</span>{groupBy === "flat" ? <Check size={14} strokeWidth={2} className="text-accent-focus" aria-hidden /> : null}
          </button>
          <div className="my-1 border-t border-border-faint" />
          <div className="px-2 py-1 text-[11px] text-text-faint">排序方式</div>
          {([
            ["manual", "手动排序"],
            ["updated", "最近更新"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={orderBy === value}
              className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
              onClick={() => choose(() => onOrderBy(value))}
            >
              <span>{label}</span>{orderBy === value ? <Check size={14} strokeWidth={2} className="text-accent-focus" aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function LeftNav({ collapsed: railCollapsed = false, onExpand, onCollapse }: { collapsed?: boolean; onExpand?: () => void; onCollapse?: () => void }) {
  const courses = useAppStore((s) => s.courses);
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const courseSessions = useAppStore((s) => s.courseSessions);
  const activeSessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const syncState = useAppStore((s) => s.syncState);
  const buildStatus = useAppStore((s) => s.buildStatus);
  const wizardOpen = useAppStore((s) => s.wizardOpen);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const { selectSession, createSession, renameSession, forkSession, archiveSession, reorderSession } = useSessionActions();

  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [wsItems, setWsItems] = useState<WorkspaceItem[]>([]);
  const [wsCourses, setWsCourses] = useState<Record<string, CourseSummary[]>>({});
  const [wsMissing, setWsMissing] = useState<Record<string, boolean>>({});
  const [switchingWs, setSwitchingWs] = useState(false);
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dragWsId, setDragWsId] = useState<string | null>(null);
  const [dragWsOver, setDragWsOver] = useState<{ id: string; half: "before" | "after" } | null>(null);
  const [dragSession, setDragSession] = useState<{ courseId: string; sessionId: string } | null>(null);
  const [dragSessionOver, setDragSessionOver] = useState<{ courseId: string; sessionId: string; half: "before" | "after" } | null>(null);
  const [sessionOrderOverrides, setSessionOrderOverrides] = useState<Record<string, SessionSummary[]>>({});
  const wsMenuRef = useRef<HTMLDivElement>(null);

  const workspaceName = workspacePath
    ? workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath
    : "StudyClaw";

  /** 注册表 + 各工作区课程并行装载（并列树的唯一数据源）。 */
  const refreshWorkspaces = useCallback(async () => {
    try {
      const payload = await api.workspaces();
      setWsItems(payload.items);
      const coursesMap: Record<string, CourseSummary[]> = {};
      const missingMap: Record<string, boolean> = {};
      await Promise.all(
        payload.items.map(async (item) => {
          try {
            const result = await api.workspaceCourses(item.path);
            coursesMap[item.path] = result.courses;
            missingMap[item.path] = result.missing;
          } catch {
            coursesMap[item.path] = [];
            missingMap[item.path] = true;
          }
        }),
      );
      setWsCourses(coursesMap);
      setWsMissing(missingMap);
    } catch {
      setWsItems([]);
    }
  }, []);

  // 挂载即载；切换工作区后（workspacePath 变化）重载以同步注册表/课程。
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces, workspacePath]);

  useEffect(() => {
    if (!wsMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wsMenuRef.current?.contains(event.target as Node)) setWsMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWsMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [wsMenuOpen]);

  async function switchWorkspace(item: WorkspaceItem) {
    if (switchingWs) return;
    if (item.path === workspacePath) {
      setWsMenuOpen(false);
      return;
    }
    setSwitchingWs(true);
    try {
      await adoptWorkspace(item.path);
      flashStatusBanner(`已切换到 ${item.title}`);
      setWsMenuOpen(false);
    } catch (cause) {
      flashStatusBanner(`✗ 切换失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSwitchingWs(false);
    }
  }

  const [confirmForget, setConfirmForget] = useState<WorkspaceItem | null>(null);

  async function forgetWorkspace(item: WorkspaceItem) {
    try {
      const payload = await api.removeWorkspace(item.id);
      setWsItems(payload.items);
      setWsCourses((previous) => {
        const next = { ...previous };
        delete next[item.path];
        return next;
      });
      if (item.path === workspacePath) {
        flashStatusBanner(`已从列表移除当前工作区（磁盘数据未删除）`);
      }
    } catch {
      // 移除失败静默：列表下次装载会重新拉取。
    }
  }

  function toggleWsCollapsed(id: string) {
    setCollapsedWs((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startRename(item: WorkspaceItem) {
    setEditingWsId(item.id);
    setRenameDraft(item.title);
  }

  async function commitRename(item: WorkspaceItem) {
    const title = renameDraft.trim();
    setEditingWsId(null);
    if (title === "" || title === item.title) return;
    try {
      const { workspace } = await api.renameWorkspace(item.id, title);
      setWsItems((previous) => previous.map((it) => (it.id === workspace.id ? workspace : it)));
    } catch (cause) {
      flashStatusBanner(`✗ 重命名失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function onWsDragStart(event: React.DragEvent, id: string) {
    setDragWsId(id);
    setDragWsOver(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }

  async function onWsDrop(event: React.DragEvent, targetId: string) {
    event.preventDefault();
    const sourceId = dragWsId;
    const marker = dragWsOver?.id === targetId ? dragWsOver.half : "before";
    setDragWsId(null);
    setDragWsOver(null);
    if (!sourceId || sourceId === targetId) return;
    const targetIndex = wsItems.findIndex((item) => item.id === targetId);
    const nextId = marker === "after" ? wsItems[targetIndex + 1]?.id : targetId;
    // 乐观重排 → 以服务端返回为准。
    setWsItems((previous) => {
      const without = previous.filter((it) => it.id !== sourceId);
      const at = nextId === undefined ? without.length : without.findIndex((it) => it.id === nextId);
      if (at < 0) return previous;
      return [...without.slice(0, at), previous.find((it) => it.id === sourceId)!, ...without.slice(at)];
    });
    try {
      const payload = await api.reorderWorkspace(sourceId, nextId);
      setWsItems(payload.items);
    } catch {
      void refreshWorkspaces();
    }
  }

  /** 点击非当前工作区的课程：先接管工作区，再选中该课程。 */
  async function openInactiveCourse(item: WorkspaceItem, course: CourseSummary) {
    closeSearch();
    try {
      if (item.path !== workspacePath) {
        await adoptWorkspace(item.path);
        flashStatusBanner(`已切换到 ${item.title}`);
      }
      useAppStore.getState().setActiveCourse(course.id);
    } catch (cause) {
      flashStatusBanner(`✗ 切换失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchOnExpand, setSearchOnExpand] = useState(false);
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearchState>({
    query: "",
    status: "idle",
    items: [],
    hasMore: false,
  });
  const [groupBy, setGroupBy] = useState<WorkspaceGroupMode>(() => {
    return "workspace";
  });
  const [orderBy, setOrderBy] = useState<WorkspaceOrderMode>(() => {
    return "updated";
  });
  const [viewPrefsHydrated, setViewPrefsHydrated] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{ session: SessionSummary; courseId: string } | null>(null);
  const [sessionRenameDraft, setSessionRenameDraft] = useState("");
  const [sessionRenameBusy, setSessionRenameBusy] = useState(false);
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null);
  const sessionRenameInputRef = useRef<HTMLInputElement>(null);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const searchAreaRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchQuery = query.trim();
  const searching = searchOpen && searchQuery.length > 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem("studyclaw:left-view-options");
        const parsed = stored
          ? (JSON.parse(stored) as { groupBy?: WorkspaceGroupMode; orderBy?: WorkspaceOrderMode })
          : null;
        if (parsed?.groupBy === "workspace" || parsed?.groupBy === "flat") setGroupBy(parsed.groupBy);
        if (parsed?.orderBy === "manual" || parsed?.orderBy === "updated") setOrderBy(parsed.orderBy);
      } catch {
        // Ignore malformed or unavailable browser storage.
      } finally {
        setViewPrefsHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!viewPrefsHydrated) return;
    try {
      window.localStorage.setItem(
        "studyclaw:left-view-options",
        JSON.stringify({ groupBy, orderBy }),
      );
    } catch {
      // Ignore unavailable browser storage.
    }
  }, [groupBy, orderBy, viewPrefsHydrated]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchOnExpand(false);
    setSessionMenuId(null);
    searchInputRef.current?.blur();
  }, []);

  useEffect(() => {
    if (sessionMenuId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-session-menu]")) setSessionMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionMenuId]);

  useEffect(() => {
    if (sessionRenameTarget === null) return;
    queueMicrotask(() => {
      sessionRenameInputRef.current?.focus();
      sessionRenameInputRef.current?.select();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sessionRenameBusy) setSessionRenameTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionRenameBusy, sessionRenameTarget]);

  function beginSessionRename(session: SessionSummary, courseId = activeCourseId) {
    if (!courseId) return;
    setSessionMenuId(null);
    setSessionRenameTarget({ session, courseId });
    setSessionRenameDraft(session.title || "");
    setSessionRenameError(null);
  }

  async function commitSessionRename() {
    const target = sessionRenameTarget;
    const title = sessionRenameDraft.trim();
    if (!target || !title || sessionRenameBusy) return;
    setSessionRenameBusy(true);
    setSessionRenameError(null);
    try {
      await renameSession(target.session.sessionId, title, target.courseId);
      setSessionRenameTarget(null);
    } catch (cause) {
      setSessionRenameError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionRenameBusy(false);
    }
  }

  async function forkFromMenu(session: SessionSummary, courseId = activeCourseId) {
    if (!courseId) return;
    setSessionMenuId(null);
    try {
      await forkSession(session.sessionId, courseId);
    } catch (cause) {
      flashStatusBanner(`✗ 创建副本失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function archiveFromMenu(session: SessionSummary, courseId = activeCourseId) {
    if (!courseId) return;
    setSessionMenuId(null);
    try {
      await archiveSession(session.sessionId, courseId);
    } catch (cause) {
      flashStatusBanner(`✗ 归档失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function renderSessionActions(session: SessionSummary, courseId: string) {
    const menuKey = sessionMenuKey(courseId, session.sessionId);
    return (
      <div className="relative" data-session-menu>
        <button
          type="button"
          aria-label="会话操作"
          title="会话操作"
          className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus group-hover:flex"
          onClick={(event) => {
            event.stopPropagation();
            setSessionMenuId((current) => current === menuKey ? null : menuKey);
          }}
        >
          <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden />
        </button>
        {sessionMenuId === menuKey ? (
          <div role="menu" className="absolute top-full right-0 z-30 w-44 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3">
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card"
              onClick={(event) => {
                event.stopPropagation();
                beginSessionRename(session, courseId);
              }}
            >
              <Pencil size={14} strokeWidth={1.8} aria-hidden />
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card"
              onClick={(event) => {
                event.stopPropagation();
                void forkFromMenu(session, courseId);
              }}
            >
              <GitBranch size={14} strokeWidth={1.8} aria-hidden />
              创建副本
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card"
              onClick={(event) => {
                event.stopPropagation();
                void archiveFromMenu(session, courseId);
              }}
            >
              <Archive size={14} strokeWidth={1.8} aria-hidden />
              归档
            </button>
            <div className="my-1 border-t border-border-faint" />
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-card"
              onClick={(event) => {
                event.stopPropagation();
                setSessionMenuId(null);
                void navigator.clipboard?.writeText(session.title || "未命名会话").catch(() => {});
              }}
            >
              <Copy size={14} strokeWidth={1.8} aria-hidden />
              复制标题
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  useEffect(() => {
    if (!searchOpen || searchOnExpand) return;
    searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOnExpand, searchOpen]);

  // dsh WorkspaceBrowser: rail search expands the column first, then focuses
  // after its slide completes. Focusing sooner forces synchronous layout.
  useEffect(() => {
    if (railCollapsed || !searchOnExpand) return;
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      setSearchOnExpand(false);
    }, EXPAND_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [railCollapsed, searchOnExpand]);

  useEffect(() => {
    // The rail click removes its own button while the pointer event is still
    // bubbling. Keep dismissal detached until the expanded search owns focus.
    if (!searchOpen || searchOnExpand) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      // A result owns its selection click and closes after the session switch.
      if (target?.closest("[data-search-result]")) return;
      if (!searchAreaRef.current?.contains(target)) closeSearch();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeSearch, searchOnExpand, searchOpen]);

  useEffect(() => {
    if (!searching) {
      setRemoteSearch({ query: "", status: "idle", items: [], hasMore: false });
      return;
    }
    const controller = new AbortController();
    setRemoteSearch({ query: searchQuery, status: "loading", items: [], hasMore: false });
    const timer = window.setTimeout(() => {
      api.searchSessions(searchQuery, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setRemoteSearch({ query: searchQuery, status: "ready", items: result.items, hasMore: result.hasMore });
      }).catch(() => {
        if (controller.signal.aborted) return;
        setRemoteSearch({ query: searchQuery, status: "error", items: [], hasMore: false });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, searching]);

  const sessionsByCourse = useMemo(() => {
    const next: Record<string, SessionSummary[]> = { ...courseSessions };
    if (activeCourseId && !next[activeCourseId]) next[activeCourseId] = activeSessions;
    for (const [courseId, sessions] of Object.entries(sessionOrderOverrides)) next[courseId] = sessions;
    return next;
  }, [activeCourseId, activeSessions, courseSessions, sessionOrderOverrides]);

  const visibleCourses = useMemo(() => {
    if (orderBy === "manual") return courses;
    return [...courses].sort((a, b) => {
      const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
      const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [courses, orderBy]);

  function toggleCollapse(courseId: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  }

  function toggleExpandedGroup(courseId: string) {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  }

  function activateCourse(course: CourseSummary) {
    closeSearch();
    if (course.id === activeCourseId) {
      toggleCollapse(course.id);
      return;
    }
    setActiveCourse(course.id);
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(course.id);
      return next;
    });
  }

  function createInCourse(course: CourseSummary) {
    closeSearch();
    if (course.id !== activeCourseId) setActiveCourse(course.id);
    void createSession(undefined, course.id);
  }

  function clearSessionOrderOverride(courseId: string) {
    setSessionOrderOverrides((previous) => {
      if (!Object.hasOwn(previous, courseId)) return previous;
      const { [courseId]: _discarded, ...rest } = previous;
      return rest;
    });
  }

  function onSessionDragStart(event: React.DragEvent, courseId: string, sessionId: string) {
    setDragSession({ courseId, sessionId });
    setDragSessionOver(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionMenuKey(courseId, sessionId));
  }

  async function onSessionDrop(
    event: React.DragEvent,
    courseId: string,
    sessions: SessionSummary[],
    targetSessionId: string,
  ) {
    event.preventDefault();
    const source = dragSession;
    const marker = dragSessionOver?.courseId === courseId && dragSessionOver.sessionId === targetSessionId
      ? dragSessionOver.half
      : "before";
    setDragSession(null);
    setDragSessionOver(null);
    if (!source || source.courseId !== courseId || source.sessionId === targetSessionId) return;
    const targetIndex = sessions.findIndex((session) => session.sessionId === targetSessionId);
    if (targetIndex < 0) return;
    const beforeId = marker === "before" ? targetSessionId : sessions[targetIndex + 1]?.sessionId;
    const reordered = moveSessionBefore(sessions, source.sessionId, beforeId);
    if (reordered.every((session, index) => session.sessionId === sessions[index]?.sessionId)) return;

    const previousOrderBy = orderBy;
    setSessionOrderOverrides((previous) => ({ ...previous, [courseId]: reordered }));
    setOrderBy("manual");
    try {
      await reorderSession(source.sessionId, beforeId, courseId);
      clearSessionOrderOverride(courseId);
    } catch (cause) {
      clearSessionOrderOverride(courseId);
      setOrderBy(previousOrderBy);
      flashStatusBanner(`✗ 会话排序失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function renderSessions(course: CourseSummary, sessions: SessionSummary[]) {
    const shown = expandedGroups.has(course.id)
      ? sessions
      : sessions.slice(0, SESSION_LIMIT);

    return (
      // DSH indent step: the workspace group wrapper already applies the single
      // 22px indent — do not nest a second margin here.
      <div className="mt-0.5">
        {shown.map((session) => {
          const active = session.sessionId === activeSessionId;
          const blank = session.turns === 0;
          const meta = blank ? "新会话" : `${relativeTime(session.lastActiveAt)}，${session.turns} 轮`;
          return (
            <div
              key={session.sessionId}
              role="treeitem"
              aria-selected={active}
              tabIndex={0}
              title={blank ? "新会话" : `${session.title} · ${meta}`}
              draggable={!blank && !searching}
              className={`ds-row-in group relative flex h-8 w-full cursor-pointer items-center gap-0 rounded-lg px-2 text-left text-[14px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus hover:bg-bg-card ${
                active ? "bg-bg-card text-accent-focus" : "text-text-primary"
              } ${dragSession?.courseId === course.id && dragSession.sessionId === session.sessionId ? "cursor-grabbing opacity-60" : !blank && !searching ? "cursor-grab" : ""}`}
              onDragStart={!blank && !searching ? (event) => onSessionDragStart(event, course.id, session.sessionId) : undefined}
              onDragOver={!blank && !searching ? (event) => {
                if (!dragSession || dragSession.courseId !== course.id || dragSession.sessionId === session.sessionId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                setDragSessionOver({
                  courseId: course.id,
                  sessionId: session.sessionId,
                  half: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
                });
              } : undefined}
              onDrop={!blank && !searching ? (event) => void onSessionDrop(event, course.id, sessions, session.sessionId) : undefined}
              onDragEnd={() => {
                setDragSession(null);
                setDragSessionOver(null);
              }}
              onClick={() => {
                closeSearch();
                if (course.id !== activeCourseId) setActiveCourse(course.id);
                void selectSession(session.sessionId, course.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (course.id !== activeCourseId) setActiveCourse(course.id);
                  void selectSession(session.sessionId, course.id);
                }
              }}
            >
              {dragSessionOver?.courseId === course.id && dragSessionOver.sessionId === session.sessionId && dragSessionOver.half === "before" ? <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent-focus" aria-hidden /> : null}
              {dragSessionOver?.courseId === course.id && dragSessionOver.sessionId === session.sessionId && dragSessionOver.half === "after" ? <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent-focus" aria-hidden /> : null}
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent-focus" /> : null}
              </span>
              <span className="mx-1 min-w-0 flex-1 truncate">
                {blank ? "新会话" : session.title}
              </span>
              {!blank ? (
                <span className="shrink-0 text-[12px] leading-5 text-text-faint group-hover:hidden">
                  {relativeTime(session.lastActiveAt)}
                </span>
              ) : null}
              {!blank ? renderSessionActions(session, course.id) : null}
            </div>
          );
        })}
        {!searching && sessions.length > SESSION_LIMIT && !expandedGroups.has(course.id) ? (
          <button
            type="button"
            className="h-6 w-full rounded-lg px-2 text-left text-[12px] text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary"
            onClick={() => toggleExpandedGroup(course.id)}
          >
            显示全部 ({sessions.length})
          </button>
        ) : null}
        {!searching ? (
          <button
            type="button"
            className="h-7 w-full rounded-lg px-2 text-left text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
            onClick={() => createInCourse(course)}
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden /> 新会话
          </button>
        ) : null}
      </div>
    );
  }

  function renderCourse(course: CourseSummary) {
    const active = course.id === activeCourseId;
    const loaded = sessionsByCourse[course.id] ?? [];
    const regularSessions = sortedVisibleSessions(loaded, activeSessionId, orderBy);
    const sessionHits = regularSessions.filter((session) =>
      matches(query, session.title, session.mode),
    );
    const courseMatches = matches(query, course.title, course.id);
    if (searching && !courseMatches && sessionHits.length === 0) return null;

    const expanded = searching || (active && !collapsed.has(course.id));
    const visible = searching
      ? (courseMatches ? regularSessions : sessionHits)
      : regularSessions;

    return (
      <div
        key={course.id}
        className="mb-0.5"
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={active}
      >
        <div
          role="button"
          tabIndex={0}
          title={course.title}
          className={`group flex h-[34px] w-full cursor-pointer items-center gap-1.5 rounded-lg border-l-2 border-transparent py-0 pr-2 pl-1.5 text-[14px] transition-colors hover:bg-bg-card ${
            active
              ? "border-accent-focus bg-bg-card font-medium text-text-primary"
              : "text-text-primary"
          }`}
          onClick={() => activateCourse(course)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activateCourse(course);
            }
          }}
        >
          <span className={`relative flex h-5 w-4 shrink-0 items-center justify-center ${active ? "text-accent-focus" : "text-text-faint"}`}>
            <Folder size={15} strokeWidth={1.7} className="absolute transition-opacity group-hover:opacity-0" aria-hidden />
            <span
              className={`absolute opacity-0 transition-all group-hover:opacity-100 ${expanded ? "rotate-90" : ""}`}
            >
              <ChevronRight size={15} strokeWidth={1.8} aria-hidden />
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate">{course.title}</span>
          {course.dueToday > 0 ? (
            <span className="shrink-0 text-[12px] text-accent-warn group-hover:hidden">
              Due {course.dueToday}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`在 ${course.title} 下新建会话`}
            title="新建会话"
            className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-[15px] leading-none text-text-faint hover:text-text-primary group-hover:flex"
            onClick={(event) => {
              event.stopPropagation();
              createInCourse(course);
            }}
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        {expanded ? renderSessions(course, visible) : null}
      </div>
    );
  }

  const renameConflict =
    editingWsId !== null &&
    renameDraft.trim() !== "" &&
    wsItems.some((it) => it.id !== editingWsId && it.title === renameDraft.trim());

  /** 非当前工作区的精简课程行（无会话数据；点击先接管该工作区）。 */
  function renderLiteCourse(item: WorkspaceItem, course: CourseSummary) {
    const active = item.path === workspacePath && course.id === activeCourseId;
    return (
      <div
        key={course.id}
        role="treeitem"
        aria-selected={active}
        title={course.title}
        className={`group flex h-[34px] w-full cursor-pointer items-center gap-1.5 rounded-lg border-l-2 border-transparent py-0 pr-2 pl-1.5 text-[14px] transition-colors hover:bg-bg-card ${
          active ? "border-accent-focus bg-bg-card font-medium text-text-primary" : "text-text-primary"
        }`}
        onClick={() => void openInactiveCourse(item, course)}
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-text-faint">
          <Folder size={15} strokeWidth={1.7} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">{course.title}</span>
        {course.dueToday > 0 ? (
          <span className="shrink-0 text-[12px] text-accent-warn">Due {course.dueToday}</span>
        ) : null}
      </div>
    );
  }

  function renderWorkspaceHeader(item: WorkspaceItem) {
    const active = item.path === workspacePath;
    const collapsed = collapsedWs.has(item.id);
    const missing = wsMissing[item.path] ?? false;
    return (
      <div
        role="button"
        tabIndex={0}
        title={missing ? `${item.path}（目录不存在）` : item.path}
        draggable
        aria-expanded={!collapsed}
        aria-selected={active}
        className={`group relative flex h-[34px] w-full cursor-grab items-center gap-1.5 rounded-lg border-l-2 py-0 pr-2 pl-1.5 text-[13px] font-medium transition-colors hover:bg-bg-card active:cursor-grabbing ${
          active ? "border-accent-focus bg-bg-card text-text-primary" : "border-transparent text-text-muted"
        } ${dragWsId === item.id ? "opacity-60" : ""}`}
        onClick={() => toggleWsCollapsed(item.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleWsCollapsed(item.id);
          }
        }}
        onDragStart={(event) => onWsDragStart(event, item.id)}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragWsId || dragWsId === item.id) return;
          setDragWsOver({ id: item.id, half: event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after" });
        }}
        onDrop={(event) => void onWsDrop(event, item.id)}
        onDragEnd={() => { setDragWsId(null); setDragWsOver(null); }}
      >
        {dragWsOver?.id === item.id && dragWsOver.half === "before" ? <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent-focus" aria-hidden /> : null}
        <span className={`relative flex h-5 w-4 shrink-0 items-center justify-center text-text-faint`}>
          <ChevronRight
            size={14}
            strokeWidth={1.8}
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
            aria-hidden
          />
        </span>
        {editingWsId === item.id ? (
          <input
            autoFocus
            value={renameDraft}
            aria-label="工作区名称"
            onChange={(event) => setRenameDraft(event.target.value.replaceAll("\0", "").slice(0, 80))}
            onBlur={() => void commitRename(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename(item);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditingWsId(null);
              }
            }}
            className={`min-w-0 flex-1 rounded border bg-bg-panel px-1 text-[13px] text-text-primary focus:outline-none ${
              renameConflict ? "border-red-500" : "border-border-line"
            }`}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className={`min-w-0 flex-1 truncate ${missing ? "text-text-faint" : ""}`}>
            {item.title}
          </span>
        )}
        {active && editingWsId !== item.id ? (
          <span className="shrink-0 text-[12px] text-accent-focus">●</span>
        ) : null}
        {!searching && editingWsId !== item.id ? (
          <>
            <button
              type="button"
              aria-label={`重命名 ${item.title}`}
              title="重命名工作区"
              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-bg-card hover:text-text-primary group-hover:flex"
              onClick={(event) => {
                event.stopPropagation();
                startRename(item);
              }}
            >
              <Pencil size={13} strokeWidth={1.8} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`移除工作区 ${item.title}`}
              title="从列表移除（不删除磁盘数据）"
              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-bg-card hover:text-text-primary group-hover:flex"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmForget(item);
              }}
            >
              <X size={13} strokeWidth={1.8} aria-hidden />
            </button>
          </>
        ) : null}
        {dragWsOver?.id === item.id && dragWsOver.half === "after" ? <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent-focus" aria-hidden /> : null}
      </div>
    );
  }

  function renderWorkspaceGroup(item: WorkspaceItem) {
    const active = item.path === workspacePath;
    const collapsed = collapsedWs.has(item.id);
    // 当前工作区用 store（权威、带会话）；其他工作区用逐工作区装载的课程。
    const list = active ? courses : (wsCourses[item.path] ?? []);
    const missing = wsMissing[item.path] ?? false;

    if (searching) {
      const matched = list.filter((course) => matches(query, course.title, course.id));
      const titleHit = matches(query, item.title);
      if (!titleHit && matched.length === 0) return null;
      const shown = titleHit ? list : matched;
      return (
        <div key={item.id} className="mb-0.5">
          {renderWorkspaceHeader(item)}
          <div className="ml-[14px] mt-0.5 space-y-0.5">
            {shown.map((course) => (active ? renderCourse(course) : renderLiteCourse(item, course)))}
          </div>
        </div>
      );
    }

    return (
      <div key={item.id} className="mb-0.5" role="treeitem" aria-expanded={!collapsed} aria-selected={active}>
        {renderWorkspaceHeader(item)}
        {!collapsed ? (
          <div className="ml-[14px] mt-0.5 space-y-0.5">
            {missing ? (
              <p className="px-2 py-1 text-[12px] leading-5 text-text-faint">目录不存在</p>
            ) : list.length === 0 ? (
              <p className="px-2 py-1 text-[12px] leading-5 text-text-faint">还没有学习项目</p>
            ) : (
              list.map((course) => (active ? renderCourse(course) : renderLiteCourse(item, course)))
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderFlatSessions() {
    const rows = visibleCourses.flatMap((course) => {
      const loaded = sortedVisibleSessions(sessionsByCourse[course.id] ?? [], activeSessionId, orderBy);
      return loaded.map((session) => ({ course, session }));
    });
    const filtered = searching
      ? rows.filter(({ course, session }) => matches(query, course.title, session.title, session.mode))
      : rows;
    if (filtered.length === 0) return null;
    return filtered.map(({ course, session }) => {
      const active = session.sessionId === activeSessionId;
      return (
        <div
          key={`${course.id}:${session.sessionId}`}
          role="treeitem"
          aria-selected={active}
          tabIndex={0}
          title={`${course.title} · ${session.title}`}
          className={`group flex min-h-9 w-full cursor-pointer items-center rounded-lg px-2 text-left transition-colors hover:bg-bg-card ${active ? "bg-bg-card text-accent-focus" : "text-text-primary"}`}
          onClick={() => {
            closeSearch();
            if (course.id !== activeCourseId) setActiveCourse(course.id);
            void selectSession(session.sessionId, course.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              closeSearch();
              if (course.id !== activeCourseId) setActiveCourse(course.id);
              void selectSession(session.sessionId, course.id);
            }
          }}
        >
          <span className="mr-2 flex h-5 w-4 shrink-0 items-center justify-center">
            {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent-focus" /> : <Folder size={13} strokeWidth={1.7} aria-hidden />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px]">{session.title}</span>
          <span className="ml-2 max-w-[35%] truncate text-[11px] text-text-faint">{course.title}</span>
          {session.turns > 0 ? renderSessionActions(session, course.id) : null}
        </div>
      );
    });
  }

  async function openSearchResult(result: SessionSearchResult) {
    closeSearch();
    try {
      if (result.workspacePath !== useAppStore.getState().workspacePath) {
        await adoptWorkspace(result.workspacePath);
        flashStatusBanner(`已切换到 ${result.workspaceTitle}`);
      }
      useAppStore.getState().setActiveCourse(result.courseId);
      await selectSession(result.sessionId, result.courseId);
    } catch (cause) {
      flashStatusBanner(`✗ 无法打开搜索结果：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function renderSearchResults() {
    const current = remoteSearch.query === searchQuery
      ? remoteSearch
      : { query: searchQuery, status: "loading" as const, items: [], hasMore: false };
    if (current.status === "loading") {
      return <p role="status" className="px-2 py-3 text-[13px] text-text-faint">正在搜索会话...</p>;
    }
    if (current.status === "error") {
      return <p role="status" className="px-2 py-3 text-[13px] text-accent-warn">搜索暂不可用</p>;
    }
    if (current.items.length === 0) {
      return <p className="px-2 py-3 text-[13px] text-text-faint">无匹配</p>;
    }
    return (
      <>
        {current.items.map((result) => {
          const active = result.workspacePath === workspacePath
            && result.courseId === activeCourseId
            && result.sessionId === activeSessionId;
      return (
        <button
          key={`${result.workspacePath}:${result.courseId}:${result.sessionId}`}
          type="button"
          role="treeitem"
          aria-selected={active}
          data-search-result
          title={`${result.workspaceTitle} · ${result.courseTitle} · ${result.title}`}
          className={`group flex min-h-12 w-full flex-col rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-bg-card ${active ? "bg-bg-card text-accent-focus" : "text-text-primary"}`}
          onClick={() => void openSearchResult(result)}
        >
          <span className="flex items-center min-w-0">
            <span className="mr-2 flex h-5 w-4 shrink-0 items-center justify-center">
              {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent-focus" /> : <Folder size={13} strokeWidth={1.7} aria-hidden />}
            </span>
            <span className="min-w-0 truncate text-[14px] leading-5">{result.title || "未命名会话"}</span>
          </span>
          <span className="ml-6 flex items-center gap-2 text-[12px] leading-[17px] text-text-faint">
            <span className="max-w-[40%] truncate">{result.workspaceTitle} · {result.courseTitle}</span>
            {!result.turns ? null : <span className="truncate">{result.turns} 轮</span>}
          </span>
          {result.snippet ? <span className="ml-6 line-clamp-2 text-[12px] leading-[17px] text-text-muted">{result.snippet}</span> : null}
        </button>
      );
        })}
        {current.hasMore ? <p className="px-2 py-2 text-[12px] text-text-faint">仅显示前 50 个结果，请继续细化关键词</p> : null}
      </>
    );
  }

  if (railCollapsed) {
    return (
      <div
        data-focus-zone="left"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col items-center py-[18px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
      >
        <button type="button" title="展开侧栏" onClick={onExpand} className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-text-primary hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus">
          <PanelLeftOpen {...iconProps} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="新建会话"
          title="新建会话"
          disabled={!activeCourseId}
          className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus disabled:opacity-40"
          onClick={() => {
            closeSearch();
            void createSession();
          }}
        >
          <Plus {...iconProps} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="搜索工作区和会话"
          title="搜索工作区和会话"
          className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          onClick={() => {
            setSearchOpen(true);
            setSearchOnExpand(true);
            onExpand?.();
          }}
        >
          <SearchGlyph />
        </button>
        <button
          type="button"
          aria-label="添加工作区"
          title="添加工作区"
          className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          onClick={() => {
            closeSearch();
            setWizardOpen(true);
          }}
        >
          <WorkspaceAddGlyph />
        </button>
        <button
          type="button"
          aria-label="导入或上传资料"
          title="导入或上传资料"
          className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          onClick={() => {
            closeSearch();
            setMaterialsOpen(true);
          }}
        >
          <Upload {...iconProps} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="设置"
          title="设置"
          className="mt-auto flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 {...iconProps} aria-hidden />
        </button>
        {confirmForget ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmForget(null);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="ws-forget-title" className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
            <h2 id="ws-forget-title" className="text-[16px] font-medium text-text-primary">确认移除项目</h2>
            <p className="mt-3 text-[13px] leading-6 text-text-secondary">
              将 <span className="font-medium text-text-primary">{confirmForget.title}</span> 从列表移除吗？
            </p>
            <p className="mt-1 text-[12px] leading-5 text-text-faint">磁盘上的数据不会被删除；再次打开同一文件夹即可恢复项目与学习记录。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmForget(null)} className="h-9 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card">取消</button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmForget;
                  setConfirmForget(null);
                  if (target) void forgetWorkspace(target);
                }}
                className="h-9 rounded-lg bg-accent-fail/90 px-3 text-[13px] font-medium text-white hover:bg-accent-fail"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {wizardOpen ? <NewProjectWizard /> : null}
        {materialsOpen ? <MaterialsDialog onClose={() => setMaterialsOpen(false)} /> : null}
      </div>
    );
  }

  return (
    <div
      data-focus-zone="left"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col px-3 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
    >
      <div className="flex h-[60px] shrink-0 items-center justify-between px-1">
        <div ref={wsMenuRef} className="relative min-w-0">
          <button
            type="button"
            aria-expanded={wsMenuOpen}
            aria-haspopup="menu"
            aria-label="切换工作区"
            title="切换工作区"
            disabled={switchingWs}
            className={`flex max-w-[170px] items-center gap-1.5 rounded-lg px-1.5 py-1 text-[15px] font-semibold text-text-primary transition-colors hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus disabled:opacity-50 ${wsMenuOpen ? "bg-bg-card" : ""}`}
            onClick={() => setWsMenuOpen((value) => !value)}
          >
            <Folder size={15} strokeWidth={1.8} className="shrink-0 text-text-muted" aria-hidden />
            <span className="truncate">{workspaceName}</span>
            <span className={`shrink-0 text-[10px] text-text-faint transition-transform ${wsMenuOpen ? "rotate-180" : ""}`}>⌄</span>
          </button>
          {wsMenuOpen ? (
            <div role="menu" className="absolute top-full left-0 z-40 mt-1 w-64 max-w-[85vw] rounded-xl border border-border-line bg-bg-panel p-1.5 shadow-lv3">
              <div className="px-2 py-1 text-[11px] text-text-faint">最近工作区</div>
              {wsItems.length === 0 ? (
                <p className="px-2 py-2 text-xs leading-5 text-text-faint">还没有打开过工作区</p>
              ) : null}
              {wsItems.map((item) => {
                const active = item.path === workspacePath;
                return (
                  <div key={item.id} className="group relative flex items-center">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={switchingWs}
                      title={item.path}
                      className="flex h-11 min-w-0 flex-1 flex-col justify-center rounded-lg px-2 py-1 text-left transition-colors hover:bg-bg-card disabled:opacity-50"
                      onClick={() => void switchWorkspace(item)}
                    >
                      <span className="flex items-center gap-1 truncate text-[13px] text-text-primary">
                        {active ? <Check size={13} strokeWidth={2} className="shrink-0 text-accent-focus" aria-hidden /> : null}
                        {item.title}
                      </span>
                      <span className="truncate text-[11px] text-text-faint">{item.path}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`从列表移除 ${item.title}`}
                      title="从列表移除（不删除磁盘数据）"
                      className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary group-hover:flex"
                      onClick={(event) => {
                        event.stopPropagation();
                        setConfirmForget(item);
                      }}
                    >
                      <X size={13} strokeWidth={1.8} aria-hidden />
                    </button>
                  </div>
                );
              })}
              <div className="my-1 border-t border-border-faint" />
              <button
                type="button"
                role="menuitem"
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
                onClick={() => {
                  setWsMenuOpen(false);
                  closeSearch();
                  setWizardOpen(true);
                }}
              >
                <WorkspaceAddGlyph />
                添加工作区…
              </button>
            </div>
          ) : null}
        </div>
        <span
          className={
            buildStatus === "running" || syncState === "syncing"
              ? "animate-pulse text-[12px] text-accent-focus"
              : syncState === "synced"
              ? "text-[12px] text-accent-pass"
              : "animate-pulse text-[12px] text-accent-focus"
          }
          title={
            buildStatus === "running"
              ? "课程知识索引构建中"
              : syncState === "synced"
                ? "状态已同步"
                : "同步中"
          }
        >
          {buildStatus === "running"
            ? "○ 构建中"
            : syncState === "synced"
              ? "● 已同步"
              : "○ 同步中"}
        </span>
        <button
          type="button"
          aria-label="折叠侧栏"
          title="折叠侧栏"
          onClick={() => {
            closeSearch();
            onCollapse?.();
          }}
          className="flex h-7 w-7 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        >
          <PanelLeftClose {...iconProps} aria-hidden />
        </button>
      </div>

      <button
        type="button"
        disabled={!activeCourseId}
        className="mb-2 flex h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-border-line bg-bg-panel text-[14px] font-medium text-text-primary transition-colors hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => {
          closeSearch();
          void createSession();
        }}
      >
        <Plus {...iconProps} aria-hidden />
        新会话
      </button>

      <div ref={searchAreaRef} className="mb-1 flex h-9 shrink-0 items-center justify-end gap-1 overflow-visible rounded-xl px-1 text-text-muted">
        <span className={`mr-auto min-w-0 truncate text-[13px] transition-all ${searchOpen ? "max-w-0 -translate-x-1 opacity-0" : "max-w-[45%] opacity-100"}`}>{groupBy === "flat" ? "会话" : "工作区"}</span>
        <div className={`flex min-w-0 items-center transition-all ${searchOpen ? "max-w-full flex-1" : "max-w-7"}`}>
          <div className={`flex h-7 min-w-0 flex-1 items-center overflow-hidden transition-all ${searchOpen ? "rounded-[10px] border border-border-line pr-1" : "rounded-full"}`}>
            <button
              type="button"
              aria-label="搜索工作区和会话"
              aria-expanded={searchOpen}
              title="搜索工作区和会话"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${searchOpen ? "bg-bg-card text-text-primary" : ""}`}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              {searchOpen ? <X {...iconProps} aria-hidden /> : <SearchGlyph />}
            </button>
            <input
              ref={searchInputRef}
              tabIndex={searchOpen ? 0 : -1}
              value={query}
              onChange={(event) => setQuery(sanitizeSearchQuery(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeSearch();
                }
              }}
              placeholder="搜索工作区或会话"
              className={`min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none ${searchOpen ? "opacity-100" : "pointer-events-none w-0 opacity-0"}`}
            />
            {searchOpen && query ? (
              <button
                type="button"
                aria-label="清空搜索"
                title="清空搜索关键词"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-faint hover:bg-bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
                onClick={() => setQuery("")}
              >
                <X size={14} strokeWidth={1.8} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        {!searchOpen ? (
          <>
            <WorkspaceViewOptions groupBy={groupBy} orderBy={orderBy} onGroupBy={setGroupBy} onOrderBy={setOrderBy} />
            <button
              type="button"
              aria-label="添加工作区"
              title="添加工作区"
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
              onClick={() => {
                closeSearch();
                setWizardOpen(true);
              }}
            >
              <WorkspaceAddGlyph />
            </button>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]" role="tree">
        {groupBy === "workspace" ? (
          wsItems.length === 0 ? (
            <p className="px-2 py-3 text-[13px] leading-5 text-text-faint">
              还没有导入工作区
            </p>
          ) : null
        ) : courses.length === 0 ? (
          <p className="px-2 py-3 text-[13px] leading-5 text-text-faint">
            还没有学习项目
          </p>
        ) : null}
        {searching
          ? renderSearchResults()
          : groupBy === "workspace"
            ? wsItems.map(renderWorkspaceGroup)
            : renderFlatSessions()}
      </div>

      <div className="mt-2 space-y-1 shrink-0 border-t border-border-line pt-2">
        <button
          type="button"
          aria-label="导入或上传资料"
          title="导入/上传课程资料"
          onClick={() => {
            closeSearch();
            setMaterialsOpen(true);
          }}
          className="flex h-[38px] w-full items-center gap-2 rounded-xl px-2.5 text-[14px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        >
          <Upload size={16} strokeWidth={1.8} aria-hidden />
          <span>导入 / 上传资料</span>
        </button>
        <button
          type="button"
          aria-label="打开设置"
          title="设置"
          onClick={() => {
            closeSearch();
            setSettingsOpen(true);
          }}
          className="flex h-[38px] w-full items-center gap-2 rounded-xl px-2.5 text-[14px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        >
          <Settings2 size={16} strokeWidth={1.8} aria-hidden />
          <span>设置</span>
        </button>
      </div>

      {confirmForget ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmForget(null);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="ws-forget-title" className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
            <h2 id="ws-forget-title" className="text-[16px] font-medium text-text-primary">确认移除项目</h2>
            <p className="mt-3 text-[13px] leading-6 text-text-secondary">
              将 <span className="font-medium text-text-primary">{confirmForget.title}</span> 从列表移除吗？
            </p>
            <p className="mt-1 text-[12px] leading-5 text-text-faint">磁盘上的数据不会被删除；再次打开同一文件夹即可恢复项目与学习记录。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmForget(null)} className="h-9 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card">取消</button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmForget;
                  setConfirmForget(null);
                  if (target) void forgetWorkspace(target);
                }}
                className="h-9 rounded-lg bg-accent-fail/90 px-3 text-[13px] font-medium text-white hover:bg-accent-fail"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {wizardOpen ? <NewProjectWizard /> : null}
      {materialsOpen ? <MaterialsDialog onClose={() => setMaterialsOpen(false)} /> : null}
      {sessionRenameTarget ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !sessionRenameBusy) setSessionRenameTarget(null);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="session-rename-title" className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-border-line bg-bg-panel p-5 shadow-lv3">
            <h2 id="session-rename-title" className="text-[16px] font-medium text-text-primary">重命名会话</h2>
            <input
              ref={sessionRenameInputRef}
              aria-label="会话名称"
              value={sessionRenameDraft}
              disabled={sessionRenameBusy}
              onChange={(event) => {
                setSessionRenameDraft(event.target.value.replaceAll("\0", "").slice(0, 120));
                setSessionRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitSessionRename();
                }
              }}
              className="mt-4 h-10 w-full rounded-lg border border-border-line bg-bg-root px-3 text-[14px] text-text-primary outline-none focus:border-accent-focus disabled:opacity-50"
            />
            {sessionRenameError ? <p role="alert" className="mt-2 text-[12px] text-accent-fail">{sessionRenameError}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={sessionRenameBusy} onClick={() => setSessionRenameTarget(null)} className="h-9 rounded-lg px-3 text-[13px] text-text-muted hover:bg-bg-card disabled:opacity-40">取消</button>
              <button type="button" disabled={sessionRenameBusy || sessionRenameDraft.trim() === ""} onClick={() => void commitSessionRename()} className="h-9 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40">{sessionRenameBusy ? "保存中..." : "保存"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
