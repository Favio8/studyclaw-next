"use client";

/**
 * 中栏对话主区（v1.4：DSH ConversationRoot 复刻）。
 *
 * - 面包屑 header（min-h 32px + 底 1px hairline）：项目 / 对话标题 +
 *   模式横幅（右）+ 对话横幅（次行）；hero 空态整行隐藏（DSH 语义）；
 * - scrollBody 单一滚动容器：748px 消息列 + sticky composer 座（顶部
 *   36px 渐隐遮罩融入背景）；
 * - hero 空态：composer 栈垂直居中 + 标题行 + 蓝色光晕；composer 实例
 *   位置不变（仅包装类切换），首条消息发送后不重挂载、焦点不丢；
 * - 流式时消息列底部「深入研究中...」品牌蓝 shimmer 行；
 * - 回到底部 34px 圆钮（距底 >24px 出现，悬浮在 composer 上方）。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import ChatInput from "@/src/components/chat/ChatInput";
import MessageCard from "@/src/components/chat/MessageCard";
import StatsLine from "@/src/components/chat/StatsLine";
import WakeupCard from "@/src/components/chat/WakeupCard";
import ApprovalPanel from "@/src/components/chat/ApprovalPanel";
import QueueDock from "@/src/components/chat/QueueDock";
import { Clawzy } from "@/src/components/mascot";
import { useChatStream } from "@/src/hooks/useChatStream";
import { useSessionActions } from "@/src/hooks/useSessionActions";
import { useAppStore } from "@/src/store/useAppStore";

/** DSH FOLLOW_THRESHOLD：距底 24px 内视为跟随态。 */
const FOLLOW_THRESHOLD = 24;

export default function ChatArea() {
  const courses = useAppStore((s) => s.courses);
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSessionTitle = useAppStore((s) => s.activeSessionTitle);
  const messages = useAppStore((s) => s.messages);
  const streaming = useAppStore((s) => s.streaming);
  const sessionBanner = useAppStore((s) => s.sessionBanner);
  const wakeupCard = useAppStore((s) => s.wakeupCard);
  const suggestedEntry = useAppStore((s) => s.suggestedEntry);
  const modeBanner = useAppStore((s) => s.modeBanner);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const { send, answer, retryLast, stop } = useChatStream();
  const { forkSession } = useSessionActions();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD,
    );
  }

  // 消息变化时若处于跟随态则滚到底（流式逐 token 跟随）
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, atBottom]);

  // 对话切换：跟随态重置（渲染期派生，官方“props 变化调整 state”模式）
  const [prevSession, setPrevSession] = useState(activeSessionId);
  if (prevSession !== activeSessionId) {
    setPrevSession(activeSessionId);
    setAtBottom(true);
  }

  if (!activeCourseId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[15px] text-text-muted">还没有学习项目</p>
        <p className="text-[13px] text-text-faint">
          在左栏点击「添加项目」打开学习项目，或先启动后端 studyclaw serve
        </p>
      </div>
    );
  }

  const hero = messages.length === 0 && !streaming;
  const courseTitle =
    courses.find((c) => c.id === activeCourseId)?.title ?? "";

  async function branchFromMessage(chatIndex: number) {
    if (!activeSessionId || !activeCourseId) return;
    try {
      await forkSession(activeSessionId, activeCourseId, chatIndex);
    } catch (cause) {
      flashStatusBanner(`✗ 无法创建分支：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 面包屑 header（hero 态隐藏，DSH ConversationRoot 语义） */}
      {!hero && (
        <header className="shrink-0 border-b border-border-line px-5 pt-3">
          <div className="flex min-h-8 items-center gap-1.5 text-[13px]">
            <span className="max-w-[40%] shrink-0 truncate rounded-lg px-2 py-0.5 text-text-muted transition-colors hover:bg-bg-card">
              {courseTitle}
            </span>
            <span className="shrink-0 px-1 text-[14px] leading-5 text-text-caption">/</span>
            <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
              {activeSessionTitle || "新对话"}
            </span>
            {modeBanner ? (
              <span
                key={modeBanner}
                className="banner-flash shrink-0 text-xs text-accent-focus"
              >
                {modeBanner}
              </span>
            ) : null}
          </div>
          {sessionBanner ? (
            <div
              key={sessionBanner}
              className="banner-flash flex min-h-6 items-center gap-2 pb-1.5 text-xs text-text-faint"
            >
              <span className="min-w-0 truncate">{sessionBanner}</span>
              {suggestedEntry ? (
                <button
                  type="button"
                  title="发送建议入口"
                  className="shrink-0 rounded-md bg-code-inline px-2 py-0.5 text-xs text-accent-focus transition-colors hover:bg-code-inline/60"
                  onClick={() => void send(suggestedEntry)}
                >
                  {suggestedEntry} →
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
      )}

      {/* scrollBody：消息流 + composer 单一滚动容器 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-conversation-scroll=""
        className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]${
          hero ? " flex flex-col justify-center" : " flex flex-col"
        }`}
      >
        {!hero && (
          <div className="mx-auto flex w-full max-w-[748px] flex-[1_0_auto] flex-col gap-4 px-8 py-4">
            {wakeupCard ? <WakeupCard card={wakeupCard} /> : null}
            {(() => {
              let persistedChatIndex = -1;
              // UI-6：重试按钮必须重发"该卡对应的用户消息"，而不是全局最后一次
              // 发送——旧失败卡在后续成功发送之后重试时，lastSent 已被覆盖。
              let lastUserText = "";
              return messages.map((msg) => {
                const hasPersistedChat = msg.persisted !== false && (msg.role === "user" || Boolean(msg.content));
                if (hasPersistedChat) persistedChatIndex += 1;
                const chatIndex = persistedChatIndex;
                if (msg.role === "user" && msg.persisted !== false) lastUserText = msg.content;
                return (
                  <MessageCard
                    key={msg.id}
                    message={msg}
                    onRetry={msg.error ? () => retryLast(lastUserText) : undefined}
                    onBranch={hasPersistedChat && activeSessionId ? () => branchFromMessage(chatIndex) : undefined}
                    branchUnavailable={streaming}
                  />
                );
              });
            })()}
            {streaming ? (
              <div className="flex h-[26px] shrink-0 items-center gap-2 text-sm font-medium">
                {/* P0-②：流式指示爪爪（icon 档），状态跟 streamPhase（thinking/writing） */}
                <Clawzy size={20} tier="icon" ariaLabel="爪爪正在工作" />
                <span className="text-shimmer">深入研究中...</span>
              </div>
            ) : null}
            <StatsLine messages={messages} />
          </div>
        )}

        {/* composer 座：hero 垂直居中 / 平时 sticky bottom（DSH composerSeat） */}
        <div
          data-composer-seat=""
          className={`relative flex-none w-full ${
            hero ? "self-center" : "sticky bottom-0 z-[7] bg-[linear-gradient(180deg,transparent_0px,var(--color-bg-panel)_36px)]"
          }`}
        >
          <ApprovalPanel agentId={activeSessionId ? `study-${activeSessionId}` : null} />
          <QueueDock />
          {hero ? (
            <>
              {/* 蓝色光晕椭圆（DSH hero：#6187D8 8% 大模糊） */}
              <div
                aria-hidden
                className="pointer-events-none absolute -top-28 left-1/2 h-[130px] w-[72%] -translate-x-1/2 rounded-[50%] bg-[#6187D8]/[0.08] blur-[50px]"
              />
              <h1 className="relative mb-2 flex items-center justify-center gap-2.5 text-[26px] font-medium leading-8 text-text-primary">
                {/* P0-①：🦞 替换为爪爪（72px 活体 idle，hero 恒静置态） */}
                <Clawzy size={72} ariaLabel="爪爪" />
                今天学点什么？
              </h1>
            </>
          ) : (
            <>
              {/* 顶部 36px 渐隐遮罩：滚动内容融入白底 */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-9 h-9 bg-gradient-to-b from-transparent to-bg-panel"
              />
              {/* 回到底部（DSH：34px 圆钮，白底 hairline + lv2） */}
              {!atBottom && messages.length > 0 ? (
                <button
                  type="button"
                  aria-label="回到底部"
                  onClick={() => {
                    const el = scrollRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                  className="absolute -top-[46px] right-4 z-[8] flex h-[34px] w-[34px] items-center justify-center rounded-full border border-border-line bg-bg-panel text-text-muted shadow-lv2 transition-colors hover:bg-bg-card hover:text-text-primary"
                >
                  <ArrowDown size={16} strokeWidth={1.8} aria-hidden />
                </button>
              ) : null}
            </>
          )}
          <ChatInput
            onSend={(text) => void send(text)}
            onAnswer={answer}
            onStop={stop}
            streaming={streaming}
            hero={hero}
          />
        </div>
      </div>
    </div>
  );
}
