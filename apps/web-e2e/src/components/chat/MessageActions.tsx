"use client";

/**
 * DSH MessageIconActions 简化复刻：
 * - 消息 hover 时显示相对时间 + 复制按钮；
 * - 复制成功短暂显示 ✓。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard, ClipboardPlus, GitBranch } from "lucide-react";
import { formatMessageTime } from "@/src/lib/format";

interface MessageActionsProps {
  text: string;
  createdAt?: string;
  clock?: "start" | "end";
  /** 对话即出题（F4）：提供时显示「转复习卡」操作按钮。 */
  onInstantCard?: (text: string) => void;
  /** 从当前已持久化消息处分叉会话（DSH message branch）。 */
  onBranch?: () => void | Promise<void>;
  /** 当前流尚未落盘，展示分支图标但不允许执行。 */
  branchUnavailable?: boolean;
}

export default function MessageActions({
  text,
  createdAt,
  clock = "start",
  onInstantCard,
  onBranch,
  branchUnavailable = false,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [branching, setBranching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // 剪贴板不可用时至少保留当前文本在选区，静默失败。
    }
  }, [text]);

  const branch = useCallback(async () => {
    if (!onBranch || branchUnavailable || branching) return;
    setBranching(true);
    try {
      await onBranch();
    } finally {
      setBranching(false);
    }
  }, [branchUnavailable, branching, onBranch]);

  return (
    <div
      data-time-hover-root=""
      className="flex h-7 items-center gap-2.5"
    >
      {clock === "start" && createdAt ? (
        <span className="hidden text-sm leading-6 text-text-faint opacity-0 transition-opacity duration-80 group-hover:opacity-100 group-focus-within:opacity-100 min-[420px]:inline">
          {formatMessageTime(createdAt)}
        </span>
      ) : null}
      {onInstantCard ? (
        <button
          type="button"
          aria-label="转为复习卡片"
          title="转为复习卡片"
          onClick={() => onInstantCard(text)}
          className="flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-text-faint transition-colors hover:bg-bg-card hover:text-accent-focus"
        >
          <ClipboardPlus size={14} strokeWidth={1.7} aria-hidden />
          转复习卡
        </button>
      ) : null}
      {onBranch ? (
        <button
          type="button"
          aria-label={branchUnavailable ? "当前回复完成后可创建分支" : "从此处创建分支"}
          aria-disabled={branchUnavailable || branching || undefined}
          title={branchUnavailable ? "当前回复完成后可创建分支" : "从此处创建分支"}
          onClick={() => void branch()}
          className="flex h-7 w-7 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        >
          <GitBranch size={14} strokeWidth={1.7} aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copied ? "已复制" : "复制"}
        title={copied ? "已复制" : "复制"}
        onClick={() => void copy()}
        className="flex h-7 w-7 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-muted"
      >
        {copied ? (
          <Check size={14} strokeWidth={1.8} aria-hidden />
        ) : (
          <Clipboard size={14} strokeWidth={1.7} aria-hidden />
        )}
      </button>
      {clock === "end" && createdAt ? (
        <span className="hidden text-sm leading-6 text-text-faint opacity-0 transition-opacity duration-80 group-hover:opacity-100 group-focus-within:opacity-100 min-[420px]:inline">
          {formatMessageTime(createdAt)}
        </span>
      ) : null}
    </div>
  );
}
