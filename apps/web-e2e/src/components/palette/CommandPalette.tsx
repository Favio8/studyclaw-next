"use client";

/**
 * Command Palette（T3.5，ui_design_spec §5 Ctrl+K / PRD §8.3）。
 *
 * - 卸载式渲染（Console 仅 paletteOpen 时挂载）：每次打开即干净初始态；
 * - 模糊过滤条目（lib/palette.fuzzyScore：子串/子序列匹配）；
 * - ↑/↓ 导航、Enter 执行、点击执行、Esc 关闭（全局 hook 兜底）；
 * - `/switch-course` 进入课程二选层（按项目标题/ID 模糊过滤），选中即切项目；
 * - 关闭后焦点恢复至打开前元素（聊天输入框场景最常见）。
 */

import { useEffect, useRef, useState } from "react";
import { filterItems, PALETTE_ITEMS } from "@/src/lib/palette";
import { createNewSession } from "@/src/lib/sessionActions";
import { useChatStream } from "@/src/hooks/useChatStream";
import { api } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type { ProviderPayload } from "@/src/types/api";

export default function CommandPalette() {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const courses = useAppStore((s) => s.courses);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const { send } = useChatStream();

  const [query, setQuery] = useState("");
  const [pickCourse, setPickCourse] = useState(false);
  const [pickModel, setPickModel] = useState(false);
  const [providers, setProviders] = useState<ProviderPayload[] | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开时的前焦点（卸载时恢复）
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      const prev = restoreRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  const items = pickModel
    ? filterItems(
        (providers ?? []).map((p) => ({
          id: p.id,
          label: p.name || p.id,
          desc: p.model,
          keywords: `${p.id} ${p.name} ${p.model}`,
          shortcut: undefined as string | undefined,
        })),
        query,
      )
    : pickCourse
      ? filterItems(
          courses.map((c) => ({
            id: c.id,
            label: c.title,
            desc: c.title,
            keywords: `${c.id} ${c.title}`,
            shortcut: undefined as string | undefined,
          })),
          query,
        )
      : filterItems(PALETTE_ITEMS, query);

  const count = items.length;
  const selected = count > 0 ? Math.min(index, count - 1) : 0;

  function closePalette() {
    setWizardOpen(false);
    setPaletteOpen(false);
  }

  function backToRoot() {
    setPickCourse(false);
    setPickModel(false);
    setQuery("");
    setIndex(0);
  }

  async function execute(id: string) {
    if (pickModel) {
      const provider = (providers ?? []).find((p) => p.id === id);
      if (provider) {
        try {
          await api.activateProvider(provider.id);
          setActiveModel({ providerId: provider.id, model: provider.model });
          flashStatusBanner(`已切换为 ${provider.name || provider.id}`);
        } catch {
          flashStatusBanner("切换失败，请稍后重试");
        }
        closePalette();
      }
      return;
    }
    if (pickCourse) {
      const course = courses.find((c) => c.id === id);
      if (course) {
        setActiveCourse(course.id);
        flashStatusBanner(`switch → ${course.title}`);
        closePalette();
      }
      return;
    }
    switch (id) {
      case "switch-course": {
        setPickModel(false);
        setPickCourse(true);
        setIndex(0);
        setQuery("");
        return; // 保持打开，进入二选层
      }
      case "switch-model": {
        setPickCourse(false);
        setPickModel(true);
        setIndex(0);
        setQuery("");
        setProviders(null);
        void api.settings().then(
          (payload) => setProviders(payload.providers),
          () => setProviders([]),
        );
        return; // 保持打开，进入模型子层
      }
      case "new-session": {
        closePalette();
        const ok = await createNewSession();
        if (!ok) flashStatusBanner("未选择项目，无法新建会话");
        return;
      }
      default: {
        closePalette();
        // Route palette actions through the same chat command path as typed
        // commands so build/sync progress is rendered in the conversation.
        void send(`/${id}`);
      }
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => (count > 0 ? (i + 1) % count : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => (count > 0 ? (i - 1 + count) % count : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (count > 0) void execute(items[selected].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (pickCourse || pickModel) {
        backToRoot();
      } else {
        closePalette();
      }
    } else if (event.key === "Tab") {
      // 弹层内让位原生 Tab（焦点循环 hook 已跳过弹层开启态）
      return;
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div className="w-[540px] max-w-[92vw] border border-border-line bg-bg-panel shadow-lg">
        {/* 输入行 */}
        <div className="flex items-center gap-2 border-b border-border-line px-3 py-2">
          <span className="text-sm text-accent-focus">❯</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            placeholder={
              pickModel
                ? "搜索供应商…"
                : pickCourse
                  ? "搜索项目…"
                  : "输入命令，如 /build /quiz /summary…"
            }
            className="flex-1 bg-transparent font-mono text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
            onKeyDown={onKeyDown}
          />
          <span className="shrink-0 text-[10px] text-text-faint">
            {pickCourse ? "Esc 返回" : "Esc 关闭"}
          </span>
        </div>

        {/* 结果列表 */}
        <div className="max-h-72 overflow-y-auto py-1">
          {count === 0 ? (
            <p className="px-3 py-2 text-[11px] text-text-faint">无匹配项</p>
          ) : (
            items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => void execute(item.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  i === selected
                    ? "bg-bg-card text-accent-focus"
                    : "text-text-muted hover:bg-bg-panel"
                }`}
              >
                <span className="w-24 shrink-0 truncate font-mono text-accent-focus">
                  {item.label}
                </span>
                <span className="truncate text-text-muted">{item.desc}</span>
                {item.shortcut ? (
                  <span className="ml-auto shrink-0 text-[10px] text-text-faint">
                    {item.shortcut}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>

        {/* 子层提示 */}
        {(pickCourse || pickModel) && (
          <div className="flex items-center justify-between border-t border-border-line px-3 py-1 text-[10px] text-text-faint">
            <span>{pickModel ? "选择要切换的供应商（全局生效）" : "选择要切换的项目"}</span>
            <button
              type="button"
              className="text-accent-focus hover:underline"
              onClick={backToRoot}
            >
              ← 返回命令
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
