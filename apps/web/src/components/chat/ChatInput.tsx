"use client";

/** DSH 风格输入栏：末尾输入 `/` 打开命令候选，输入 `@` 搜索课程文件。 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Paperclip, Plus, Square, X } from "lucide-react";
import { MODES } from "@/src/lib/modes";
import { api } from "@/src/lib/api";
import { COMMANDS } from "@/src/lib/commands";
import { useAppStore } from "@/src/store/useAppStore";
import ModelSeat from "@/src/components/chat/ModelSeat";

interface ChatInputProps {
  onSend: (text: string) => void;
  onAnswer?: (text: string) => Promise<boolean>;
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

export default function ChatInput({ onSend, onAnswer, onStop, streaming, hero }: ChatInputProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [files, setFiles] = useState<FileCandidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [answering, setAnswering] = useState(false);
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
  // 爪爪 listening 态输入源：输入框聚焦/失焦写全局，供 useMascotState 派生
  const setChatFocus = useAppStore((s) => s.setChatFocus);
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

  async function submit() {
    const text = value.trim();
    if (!text || answering) return;
    if (pendingAsk && onAnswer) {
      setAnswering(true);
      try {
        if (await onAnswer(text)) setComposerDraft(draftKey, "");
      } finally {
        setAnswering(false);
        inputRef.current?.focus();
      }
      return;
    }
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

  const canSend = value.trim().length > 0 && !streaming && !answering;
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
    if (!attachmentMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-attachment-menu]")) setAttachmentMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAttachmentMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [attachmentMenuOpen]);

  useEffect(() => {
    setHighlight(0);
  }, [token?.trigger, token?.query]);

  function chooseMode(nextMode: (typeof MODES)[number]) {
    setMode(nextMode.value);
    flashModeBanner(`已切换 · ${nextMode.label}`);
    setModeMenuOpen(false);
  }

  function appendAttachment(file: FileCandidate): void {
    const marker = `@${file.relative}`;
    const current = useAppStore.getState().composerDrafts[draftKey] ?? value;
    if (!current.includes(marker)) {
      const prefix = current.trimEnd();
      setComposerDraft(draftKey, `${prefix}${prefix === "" ? "" : " "}${marker} `);
    }
    setAttachmentMenuOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function removeAttachment(file: FileCandidate): void {
    const marker = `@${file.relative}`;
    const current = useAppStore.getState().composerDrafts[draftKey] ?? value;
    setComposerDraft(draftKey, current.replace(new RegExp(`(?:^|\\s)${escapeRegExp(marker)}(?=\\s|$)`, "g"), " ").replace(/\s{2,}/g, " ").trimStart());
  }

  function dropAttachments(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const names = new Set(Array.from(event.dataTransfer.files).map((file) => file.name.toLowerCase()));
    const matches = files.filter((file) => names.has(file.relative.split("/").pop()?.toLowerCase() ?? ""));
    for (const file of matches) appendAttachment(file);
  }

  return (
    <div className="flex w-full justify-center px-4 pb-2">
      <div data-composer-card onDragOver={(event) => event.preventDefault()} onDrop={dropAttachments} className="relative flex w-full max-w-[780px] flex-col gap-3 rounded-[22px] border border-border-line bg-bg-panel pt-2.5 shadow-lv2">
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
          onFocus={() => setChatFocus(true)}
          onBlur={() => setChatFocus(false)}
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

        {files.some((file) => value.includes(`@${file.relative}`)) ? (
          <div className="flex flex-wrap gap-1.5 px-3 -mt-1" aria-label="已附加课程资料">
            {files.filter((file) => value.includes(`@${file.relative}`)).map((file) => (
              <span key={file.relative} className="inline-flex max-w-full items-center gap-1 rounded-md bg-code-inline px-2 py-1 text-[11px] text-text-muted">
                <FileText size={12} aria-hidden />
                <span className="max-w-[220px] truncate">{file.relative}</span>
                <button type="button" aria-label={`移除附件 ${file.relative}`} title="移除附件" onClick={() => removeAttachment(file)} className="rounded p-0.5 text-text-faint hover:bg-bg-card hover:text-text-primary"><X size={12} aria-hidden /></button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
          {/* ③ 三段分组：工具 / 模型 / 模式——段间 1px 淡线，颜色从四种降到三种，
              激活态与悬停都有明确层级。 */}
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" aria-label="打开指令面板" title="指令与快捷操作（Ctrl+K）" onClick={() => setPaletteOpen(true)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-selector text-[14px] leading-none text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"><Plus size={15} strokeWidth={1.8} aria-hidden /></button>
              <div data-attachment-menu className="relative">
                <button type="button" aria-label="添加课程资料" title="添加课程资料（也可拖入当前资料）" aria-expanded={attachmentMenuOpen} onClick={() => setAttachmentMenuOpen((open) => !open)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-selector text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"><Paperclip size={14} strokeWidth={1.8} aria-hidden /></button>
                {attachmentMenuOpen ? (
                  <div role="listbox" aria-label="课程资料" className="absolute bottom-[calc(100%+8px)] left-0 z-30 max-h-64 w-72 overflow-y-auto rounded-xl border border-border-line bg-bg-panel p-1.5 shadow-lv3">
                    {files.length === 0 ? <div className="px-3 py-2 text-xs text-text-faint">当前课程没有可引用资料</div> : files.slice(0, 50).map((file) => {
                      const attached = value.includes(`@${file.relative}`);
                      return <button key={file.relative} type="button" role="option" aria-selected={attached} onMouseDown={(event) => { event.preventDefault(); appendAttachment(file); }} className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${attached ? "bg-code-inline text-accent-focus" : "text-text-muted hover:bg-bg-card"}`}><FileText size={13} aria-hidden /><span className="min-w-0 flex-1 truncate">{file.relative}</span>{attached ? <span aria-hidden>✓</span> : null}</button>;
                    })}
                  </div>
                ) : null}
              </div>
            </div>
            <span aria-hidden className="h-4 w-px shrink-0 bg-border-faint" />
            <ModelSeat />
            <span aria-hidden className="h-4 w-px shrink-0 bg-border-faint" />
            {/* 模式：只显示当前项，点开选择（与模型座位/思考强度同 pattern）。
                宽窄屏共用这一个控件——旧实现宽屏用四按钮分段控件，行内空间不足时
                CJK 无词边界、按字折断成两行（实测截图），故统一收成单控件。 */}
            <div data-mode-menu className="relative flex shrink-0">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                title="切换学习模式"
                onClick={() => setModeMenuOpen((open) => !open)}
                className="flex h-7 max-w-[132px] items-center gap-1 rounded-lg border border-border-faint bg-bg-card/60 px-2 text-[13px] font-medium leading-5 text-text-primary transition-colors hover:bg-bg-card"
              >
                <span className="truncate">{activeMode.label}</span>
                <ChevronDown size={12} strokeWidth={1.8} className="shrink-0 text-text-faint" aria-hidden />
              </button>
              {modeMenuOpen ? (
                <div role="menu" aria-label="切换学习模式" className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-32 rounded-xl border border-border-line bg-bg-panel p-1 shadow-lv3">
                  {MODES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={item.value === mode}
                      onClick={() => chooseMode(item)}
                      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] ${item.value === mode ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card hover:text-text-primary"}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.value === mode ? <Check size={14} className="shrink-0 text-accent-focus" aria-hidden /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
