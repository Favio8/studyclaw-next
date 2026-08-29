"use client";

/**
 * 消息（v1.4：DSH MessageItem 复刻）：
 * - 用户：右对齐淡蓝气泡 + 下方 hover 时间/复制操作；
 * - Agent：全宽左对齐无气泡无卡，块序列 = ReasoningRow → markdown 正文；
 *   底部追加 hover 时间/复制操作；
 * - 失败：错误行 + 重试键；
 * - 对话即出题（F4）：hover 操作区「转复习卡」按钮 + 划选段落后的浮动按钮，
 *   复用 TaskGenerator 生成永久复习卡到 tasks/ 池。
 */

import { useCallback, useRef, useState } from "react";
import ThinkingFold from "@/src/components/chat/ThinkingFold";
import ToolFold from "@/src/components/chat/ToolFold";
import AskFold from "@/src/components/chat/AskFold";
import MarkdownView from "@/src/components/chat/MarkdownView";
import MessageActions from "@/src/components/chat/MessageActions";
import { Clawzy } from "@/src/components/mascot";
import useInstantCard from "@/src/hooks/useInstantCard";
import type { ChatMessage } from "@/src/store/useAppStore";

interface MessageCardProps {
  message: ChatMessage;
  onRetry?: () => void;
  onBranch?: () => void | Promise<void>;
  branchUnavailable?: boolean;
}

export default function MessageCard({ message, onRetry, onBranch, branchUnavailable }: MessageCardProps) {
  const { create, feedback } = useInstantCard();
  const [selectedSnippet, setSelectedSnippet] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  const onMouseUpInContent = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const anchored = contentRef.current?.contains(selection?.anchorNode ?? null);
    const focused = contentRef.current?.contains(selection?.focusNode ?? null);
    setSelectedSnippet(anchored && focused ? text : "");
  }, []);

  const convertSnippet = useCallback(
    (text: string) => {
      setSelectedSnippet("");
      void create(text, `对话精妙段落：${text.slice(0, 24)}`);
    },
    [create],
  );

  const actionHandler = useCallback(
    (text: string) => convertSnippet(text),
    [convertSnippet],
  );

  if (message.role === "user") {
    return (
      <div data-time-hover-root="" className="group flex flex-col items-end gap-1.5">
        <div className="max-w-[min(525px,82%)] rounded-[22px] bg-bubble px-4 py-2.5 text-[16px] leading-6 text-text-primary">
          <MarkdownView content={message.content} bubble />
        </div>
        <MessageActions
          text={message.content}
          createdAt={message.createdAt}
          clock="start"
          onInstantCard={actionHandler}
          onBranch={onBranch}
          branchUnavailable={branchUnavailable}
        />
        {feedback.message ? (
          <span role="status" className="text-[12px] text-text-faint">
            {feedback.message}
          </span>
        ) : null}
      </div>
    );
  }

  const streaming = message.streaming === true;

  return (
    <div data-time-hover-root="" className="group relative flex min-w-0 flex-col gap-2">
      {/* P0-④：AI 消息署名行——20px 纯图标（拍板决策不带文字），状态自动派生：
          历史消息 idle，流式中的最后一条跟随 thinking/writing */}
      <div className="flex items-center">
        <Clawzy size={20} tier="icon" ariaLabel="StudyClaw" />
      </div>
      {message.thinking ? (
        <ThinkingFold
          thinking={message.thinking}
          thinkingMs={message.thinkingMs}
        />
      ) : null}
        {message.tools?.length ? (
          <ToolFold tools={message.tools} />
        ) : null}
      {message.ask ? (
        <AskFold question={message.ask.question} />
      ) : null}
      {message.content ? (
        <div ref={contentRef} className="min-w-0" onMouseUp={onMouseUpInContent}>
          <MarkdownView content={message.content} />
          {streaming ? (
            <span className="stream-cursor text-accent-focus">█</span>
          ) : null}
        </div>
      ) : null}
      {selectedSnippet ? (
        <div className="absolute right-0 top-0 z-10 rounded-lg border border-border-line bg-bg-panel p-1 shadow-lg">
          <button
            type="button"
            aria-label="把选区转为复习卡片"
            onClick={() => convertSnippet(selectedSnippet)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-accent-focus transition-colors hover:bg-bg-card"
          >
            <span className="max-w-[180px] truncate">“{selectedSnippet}”</span>
            转复习卡
          </button>
        </div>
      ) : null}
      {!streaming ? (
        <MessageActions
          text={message.content || message.thinking || ""}
          createdAt={message.createdAt}
          clock="end"
          onInstantCard={actionHandler}
          onBranch={message.content ? onBranch : undefined}
          branchUnavailable={branchUnavailable}
        />
      ) : null}
      {feedback.message ? (
        <span role="status" className="text-[12px] text-text-faint">
          {feedback.message}
        </span>
      ) : null}
      {message.error ? (
        <div
          className="flex items-center gap-2 rounded-lg bg-accent-fail/10 px-3 py-1.5 text-[13px] text-accent-fail"
          role="alert"
        >
          <span>× {message.error}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto rounded-md border border-accent-fail/50 px-2 py-0.5 hover:bg-accent-fail/20"
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
