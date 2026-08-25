"use client";

/** DSH 风格输入栏：末尾输入 `/` 打开命令候选，输入 `@` 搜索课程文件。 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import { MODES } from "@/src/lib/modes";
import { api } from "@/src/lib/api";
import { COMMANDS } from "@/src/lib/commands";
import { useAppStore } from "@/src/store/useAppStore";
import ModelSeat from "@/src/components/chat/ModelSeat";

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  streaming?: boolean;
  hero?: boolean;
}

type Trigger = "/" | "@";
interface FileCandidate {
  relative: string;
  size: number;
}

const TEXTAREA_MAX = 336;

function activeToken(value: string): { trigger: Trigger; query: string; start: number } | null {
  const match = /(^|\s)([/@])([^\s]*)$/.exec(value);
  if (!match || !match[2]) return null;
  return { trigger: match[2] as Trigger, query: match[3] ?? "", start: match.index + match[1].length };
}

export default function ChatInput({ onSend, onStop, streaming, hero }: ChatInputProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [files, setFiles] = useState<FileCandidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  const mode = useAppStore((s) => s.mode);
  const pendingAsk = useAppStore((s) => s.pendingAsk);
  const setMode = useAppStore((s) => s.setMode);
  const flashModeBanner = useAppStore((s) => s.flashModeBanner);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const draftKey = `${workspacePath ?? ""}\0${activeCourseId ?? ""}\0${activeSessionId ?? "new"}`;
  const value = useAppStore((s) => s.composerDrafts[draftKey] ?? "");
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const token = activeToken(value);
  const menuOpen = Boolean(token && !streaming);

  useEffect(() => {
    if (!activeCourseId) return;
    let alive = true;
    api.courseFiles(activeCourseId).then((result) => {
      if (alive) {
        setFiles(result.files.filter((file) => file.supported).map((file) => ({
          relative: file.relative,
          size: file.size,
        })));
      }
    }).catch(() => {
      if (alive) setFiles([]);
    });
    return () => { alive = false; };
  }, [activeCourseId]);

  const candidates = useMemo(() => {
    if (!token) return [] as Array<{ label: string; description?: string }>;
    const query = token.query.toLowerCase();
    if (token.trigger === "/") {
      return COMMANDS
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({ label: `/${command.name}`, description: command.description }));
    }
    return files
      .filter((file) => file.relative.toLowerCase().includes(query))
      .slice(0, 30)
      .map((file) => ({ label: `@${file.relative}`, description: formatBytes(file.size) }));
  }, [files, token]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setComposerDraft(draftKey, "");
    inputRef.current?.focus();
  }

  const activeHighlight = Math.min(highlight, Math.max(0, candidates.length - 1));

  function chooseCandidate(index = activeHighlight) {
    const candidate = candidates[index];
    if (!candidate || !token) return;
    const next = `${value.slice(0, token.start)}${candidate.label} `;
    setComposerDraft(draftKey, next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  }

  const canSend = value.trim().length > 0 && !streaming;
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0];

  useEffect(() => {
    if (!modeMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-mode-menu]")) setModeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModeMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modeMenuOpen]);

  useEffect(() => {
    setHighlight(0);
  }, [token?.trigger, token?.query]);

  function chooseMode(nextMode: (typeof MODES)[number]) {
    setMode(nextMode.value);
    flashModeBanner(`已切换 · ${nextMode.label}`);
    setModeMenuOpen(false);
  }

  return (
    <div className="flex w-full justify-center px-4 pb-2">
      <div data-composer-card className="relative flex w-full max-w-[780px] flex-col gap-3 rounded-[22px] border border-border-line bg-bg-panel pt-2.5 shadow-lv2">
        {menuOpen && candidates.length > 0 ? (
          <div role="listbox" aria-label={token?.trigger === "/" ? "快捷命令" : "课程文件"} className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 max-h-80 overflow-y-auto rounded-xl border border-border-line bg-bg-panel p-1.5 shadow-lv3">
            {candidates.map((candidate, index) => (
              <button
                key={candidate.label}
                type="button"
                role="option"
                aria-selected={index === activeHighlight}
                onMouseDown={(event) => { event.preventDefault(); chooseCandidate(index); }}
                className={`flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left ${index === activeHighlight ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70"}`}
              >
                <span className="font-mono text-[13px]">{candidate.label}</span>
                {candidate.description ? <span className="ml-auto truncate text-[11px] text-text-faint">{candidate.description}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          data-focus-zone="input"
          tabIndex={-1}
          value={value}
          rows={hero ? 2 : 1}
          placeholder={
            pendingAsk
              ? `回答：${pendingAsk.question.slice(0, 40)}${pendingAsk.question.length > 40 ? "…" : ""}`
              : hero
                ? "描述你想学习的内容..."
                : "给导师发消息，输入 / 查看命令，输入 @ 引用文件"
          }
          onChange={(event) => setComposerDraft(draftKey, event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            // Match dsh InputBar: a held Enter must never submit one draft twice.
            if (event.key === "Enter" && event.repeat && !event.shiftKey) {
              event.preventDefault();
              return;
            }
            if (menuOpen && candidates.length > 0) {
              if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((index) => (index + 1) % candidates.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => (index - 1 + candidates.length) % candidates.length); return; }
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                const exactCommand = token?.trigger === "/"
                  && candidates.length === 1
                  && candidates[0]?.label.slice(1) === token.query;
                if (event.key === "Enter" && exactCommand) submit();
                else chooseCandidate();
                return;
              }
              if (event.key === "Escape") { event.preventDefault(); setComposerDraft(draftKey, value.slice(0, token?.start ?? value.length)); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              inputRef.current?.blur();
            }
          }}
          className="w-full resize-none bg-transparent pl-4 pr-3 pt-1 font-sans text-[16px] leading-6 text-text-primary caret-accent-focus placeholder:text-text-caption focus:outline-none disabled:opacity-50"
          style={{ minHeight: hero ? 52 : undefined }}
        />

        <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
          <div className="flex items-center gap-3">
            <button type="button" aria-label="打开指令面板" title="指令与快捷操作（Ctrl+K）" onClick={() => setPaletteOpen(true)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-selector text-[14px] leading-none text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"><Plus size={15} strokeWidth={1.8} aria-hidden /></button>
            <ModelSeat />
            <div className="hidden min-[1180px]:flex items-center gap-2">
              {MODES.map((item) => {
                const active = item.value === mode;
                return <button key={item.value} type="button" title={`切换到${item.label}模式`} onClick={() => chooseMode(item)} className={`h-7 rounded-lg px-2 text-[13px] font-medium leading-5 transition-colors ${active ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-black/[0.06] hover:text-text-primary"}`}>{item.label}</button>;
              })}
            </div>
            <div data-mode-menu className="relative flex min-[1180px]:hidden">
              <button type="button" aria-expanded={modeMenuOpen} title="切换学习模式" onClick={() => setModeMenuOpen((open) => !open)} className="flex h-7 items-center gap-1 rounded-lg bg-bg-card px-2 text-[13px] font-medium text-text-primary"><span>{activeMode.label}</span><ChevronDown size={12} strokeWidth={1.8} aria-hidden /></button>
              {modeMenuOpen ? <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-28 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3">{MODES.map((item) => <button key={item.value} type="button" onClick={() => chooseMode(item)} className={`flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] ${item.value === mode ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}>{item.label}</button>)}</div> : null}
            </div>
          </div>
          <button type="button" title={streaming ? "停止生成" : "发送（Enter）"} disabled={streaming ? false : !canSend} onClick={() => (streaming ? onStop?.() : submit())} className="flex h-[34px] w-[34px] shrink-0 -translate-y-0.5 items-center justify-center rounded-full bg-accent-focus text-white transition-colors hover:bg-accent-focus-hover disabled:opacity-40">
            {streaming ? <Square size={12} fill="currentColor" strokeWidth={1.8} aria-hidden /> : <ArrowUp size={16} strokeWidth={1.8} aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
