"use client";

/**
 * 中栏对话流编排（T3.3，api_spec §3.1）。
 *
 * send(text)：
 * 1. 指令拦截（`/xxx` 命令前缀走 `lib/commands.ts`，兼容旧 `:xxx`）；
 * 2. 用户消息入 store + agent 占位（streaming）→ SSE 消费事件流；
 * 3. meta：同步真实 sessionId（无会话时服务端自动新建）+ 刷新左栏会话列表；
 * 4. thinking/token：局部 ref 累积 + requestAnimationFrame 批量打补丁
 *    （每帧至多一次 store 更新，平滑渲染）；
 * 5. sync：置 syncing 态 → 右栏面板刷新（done 后回 synced）；
 * 6. done：定格 thinking 耗时、落 lastTurnId（断线重连用）；
 * 7. error：消息卡错误态 + 状态横幅提示。
 *
 * 断线重连：最多 3 次尝试；attempt≥1 携带 `Last-Event-ID: t_<k>`
 * （k = 当前用户消息序号）。服务端命中已落盘轮次 → 重放正文（替换占位）；
 * 未落盘 → 重新生成完整流（占位先清空）。用户消息不重复追加。
 *
 * 会话切换/新建由 useSessionActions 调 abortActiveChat() 中止旧流；
 * isAbortError 不触发重试。
 */

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/src/lib/api";
import {
  isAbortError,
  registerActiveChat,
  streamChat,
  unregisterActiveChat,
} from "@/src/lib/chatStream";
import { COMMANDS, parseCommand, runCommand } from "@/src/lib/commands";
import {
  notifyPanelChanged,
  refreshCourseList,
} from "@/src/lib/panelData";
import { usePanelData } from "@/src/hooks/usePanelData";
import { nextMessageId, useAppStore } from "@/src/store/useAppStore";
import type { ChatEvent, ToolCallView } from "@/src/types/api";

const MAX_ATTEMPTS = 3;

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export function useChatStream() {
  const setStreaming = useAppStore((s) => s.setStreaming);
  const setSyncState = useAppStore((s) => s.setSyncState);
  const setPendingAsk = useAppStore((s) => s.setPendingAsk);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const updateLastAgent = useAppStore((s) => s.updateLastAgent);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setLastTurnId = useAppStore((s) => s.setLastTurnId);
  const setSessions = useAppStore((s) => s.setSessions);
  const setActiveSessionTitle = useAppStore((s) => s.setActiveSessionTitle);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const { refresh: refreshPanel } = usePanelData();

  // 活跃流缓冲（避免每个 token 触发一次 store 更新）
  const contentRef = useRef("");
  const thinkingRef = useRef("");
  const toolsRef = useRef<ToolCallView[]>([]);
  const thinkingStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSentRef = useRef<string>("");
  const expectedTurnRef = useRef(0);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (abortRef.current) abortRef.current.abort();
    },
    [],
  );

  const refreshSessions = useCallback(
    async (courseId: string, sessionId?: string) => {
      try {
        const { sessions } = await api.sessions(courseId);
        setSessions(sessions);
        useAppStore.getState().setCourseSessions(courseId, sessions);
        // 同步激活对话标题：发送时落盘的 session/title 让面包屑脱离「新会话」。
        if (sessionId) {
          const current = sessions.find((session) => session.sessionId === sessionId);
          if (current && current.title) setActiveSessionTitle(current.title);
        }
      } catch {
        /* 静默：左栏下次装载再修正 */
      }
    },
    [setActiveSessionTitle, setSessions],
  );

  const flush = useCallback(() => {
    rafRef.current = null;
    const elapsed = thinkingStartRef.current
      ? Math.max(0, Math.round(performance.now() - thinkingStartRef.current))
      : 0;
    updateLastAgent({
      content: contentRef.current,
      thinking: thinkingRef.current,
      thinkingMs: elapsed,
        tools: toolsRef.current.slice(),
      streaming: true,
    });
  }, [updateLastAgent]);

  const cancelPendingFlush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const handleEvent = useCallback(
    (ev: ChatEvent) => {
      switch (ev.event) {
        case "meta": {
          const { sessionId, model, provider } = ev.data;
          const state = useAppStore.getState();
          if (model) {
            // 模型座位数据源（api_spec §3.1 v2.6）：本轮实际生效的 provider/model
            state.setActiveModel({ providerId: provider ?? "", model });
          }
          if (sessionId && sessionId !== state.activeSessionId) {
            // 无会话发送时服务端自动新建：更新激活会话但保留流式消息
            setActiveSession(sessionId, "");
            const courseId = state.activeCourseId;
            if (courseId) void refreshSessions(courseId);
          }
          break;
        }
        case "thinking": {
          thinkingRef.current += ev.data.delta;
          if (thinkingStartRef.current === null) {
            thinkingStartRef.current = performance.now();
          }
          scheduleFlush();
          break;
        }
        case "token": {
          contentRef.current += ev.data.delta;
          scheduleFlush();
          break;
        }
        case "tool": {
          toolsRef.current = [...toolsRef.current, ev.data];
          scheduleFlush();
          break;
        }
        case "ask": {
          // M-C (Sprint 8): explicit ask -> composer answer state + AskFold on message.
          setPendingAsk(ev.data);
          updateLastAgent({ ask: ev.data });
          break;
        }
        case "sync": {
          setSyncState("syncing");
          void refreshPanel();
          void refreshCourseList(); // 左栏 Due 徽标随进度变化
          notifyPanelChanged("progress"); // 进度数据已变
          break;
        }
        case "done": {
          const eventId = (ev as { id?: string }).id ?? null;
          if (eventId) setLastTurnId(eventId);
          cancelPendingFlush(); // 收尾：清掉可能残留的 rAF，防跨轮误冲
          const elapsed = thinkingStartRef.current
            ? Math.max(0, Math.round(performance.now() - thinkingStartRef.current))
            : 0;
          updateLastAgent({
            // SSE can deliver its final token and done in one browser frame.
            // Commit the buffers before cancelling the scheduled rAF so the
            // transcript never loses that last response chunk.
            content: contentRef.current,
            thinking: thinkingRef.current,
            // 收尾定格工具折叠（防止 done 抢在 rAF flush 前把最后一条工具丢帧）
            ...(toolsRef.current.length ? { tools: toolsRef.current.slice() } : {}),
            streaming: false,
            ...(thinkingStartRef.current !== null ? { thinkingMs: elapsed } : {}),
          });
          setSyncState("synced");
          // 完成即刷新左栏：turns 与标题（发送时已落盘的 session/title）立即可见；
          // LLM 智能标题稍后落盘，延迟再静默刷一次（无推送通道，不改 SSE 协议）。
          {
            const state = useAppStore.getState();
            const courseId = state.activeCourseId;
            if (courseId) {
              const sessionId = state.activeSessionId;
              void refreshSessions(courseId, sessionId || undefined);
              window.setTimeout(() => {
                void refreshSessions(useAppStore.getState().activeCourseId ?? courseId, useAppStore.getState().activeSessionId || undefined);
              }, 3000);
            }
          }
          break;
        }
        case "error": {
          throw new Error(`${ev.data.code}: ${ev.data.message}`);
        }
        default: {
          /* 未知事件类型：契约外，忽略 */
        }
      }
    },
    [cancelPendingFlush, refreshPanel, refreshSessions, scheduleFlush, setActiveSession, setLastTurnId, setPendingAsk, setSyncState, updateLastAgent],
  );

  const send = useCallback(
    async (text: string, opts?: { skipAppendUser?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (useAppStore.getState().streaming) return; // 一条活跃流

      const courseId = useAppStore.getState().activeCourseId;
      if (!courseId) {
        flashStatusBanner("未选择项目");
        return;
      }

      // 指令拦截（命令前缀可带参数；普通文本中的 / 与 @ 不受影响）
      const cmd = parseCommand(trimmed);
      let requestText = trimmed;
      if (cmd) {
        // Commands do not enter the tutor SSE stream, so render their own
        // turn immediately while a background build/sync job is running.
        const commandDefinition = COMMANDS.find((item) => item.name === cmd);
        if (commandDefinition && cmd !== "summary") {
          const commandUserId = opts?.skipAppendUser ? null : nextMessageId();
          const commandAgentId = nextMessageId();
          if (commandUserId) {
            appendMessage({ id: commandUserId, role: "user", content: trimmed, createdAt: new Date().toISOString(), persisted: false });
          }
          const pending =
            cmd === "build"
              ? "BUILD // 正在构建课程知识索引…"
              : cmd === "sync"
                ? "SYNC // 正在扫描课程资料…"
                : `${cmd.toUpperCase()} // 执行中…`;
          appendMessage({
            id: commandAgentId,
            role: "agent",
            content: pending,
            createdAt: new Date().toISOString(),
            streaming: cmd === "build" || cmd === "sync",
            mode: useAppStore.getState().mode,
            persisted: false,
          });
          const result = await runCommand(cmd);
          if (result.handled) {
            updateMessage(commandAgentId, {
              content: result.feedback ?? pending,
              streaming: false,
            });
            return;
          }
          updateMessage(commandAgentId, { content: "", streaming: false });
        }
      }
      if (cmd && !COMMANDS.some((item) => item.name === cmd)) {
        flashStatusBanner(
          `未知指令 /${cmd}（支持 /build /quiz /review /summary /sync /switch-course）`,
        );
        return;
      }
      if (cmd === "summary") {
        const result = await runCommand(cmd);
        if (result.handled) {
          if (result.feedback) flashStatusBanner(result.feedback);
        }
        if (result.prompt) requestText = result.prompt;
        else return;
      }

      const fileRefs = Array.from(requestText.matchAll(/@([^\s]+)/g))
        .map((match) => match[1]?.replace(/[),.;:!?]+$/, ""))
        // Plain @words are ordinary prose (email/user mentions). A selected
        // course file has a path or a supported document extension.
        .filter(
          (ref): ref is string =>
            Boolean(ref) && (ref.includes("/") || /\.(?:md|txt|pdf)$/i.test(ref)),
        );

      const state = useAppStore.getState();
      const curMode = state.mode;
      const sessionId = state.activeSessionId;
      const conceptId = state.focusConceptId;

      // 第 k 条用户消息 → 期望轮次 t_<k>（断线重连 Last-Event-ID）
      const userCount = state.messages.filter((m) => m.role === "user").length;
      const expectedTurn = opts?.skipAppendUser
        ? expectedTurnRef.current
        : userCount + 1;
      expectedTurnRef.current = expectedTurn;
      lastSentRef.current = requestText;

      if (!opts?.skipAppendUser) {
        appendMessage({ id: nextMessageId(), role: "user", content: trimmed, createdAt: new Date().toISOString() });
      }
      appendMessage({
        id: nextMessageId(),
        role: "agent",
        content: "",
        thinking: "",
        createdAt: new Date().toISOString(),
        streaming: true,
        mode: curMode,
      });

      const abort = new AbortController();
      abortRef.current = abort;
      registerActiveChat(abort);
      setStreaming(true);
      setSyncState("synced");
      setPendingAsk(null); // new send answers/clears pending ask
      contentRef.current = "";
      thinkingRef.current = "";
      thinkingStartRef.current = null;
        toolsRef.current = [];

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          // 重试：占位先清空（重放或重流都会重新填充）
          contentRef.current = "";
          thinkingRef.current = "";
          thinkingStartRef.current = null;
            toolsRef.current = [];
          updateLastAgent({ content: "", thinking: "", streaming: true });
        }
        try {
          for await (const ev of streamChat(
            {
              courseId,
              message: requestText,
              mode: curMode,
              sessionId,
              conceptId,
              fileRefs,
              lastEventId: attempt > 0 ? `t_${expectedTurn}` : null,
            },
            abort.signal,
          )) {
            if (abort.signal.aborted) break;
            handleEvent(ev);
          }
          // 成功完成：收尾（done 已定格消息卡，此处清全局流态）
          cancelPendingFlush();
          setStreaming(false);
          unregisterActiveChat(abort);
          abortRef.current = null;
          return;
        } catch (exc) {
          if (isAbortError(exc) || abort.signal.aborted) {
            // 用户停止/切换会话：定格占位卡（切换方随后可能清空消息）
            cancelPendingFlush();
            updateLastAgent({ streaming: false });
            break;
          }
          if (attempt < MAX_ATTEMPTS - 1) continue;
          cancelPendingFlush();
          updateLastAgent({
            streaming: false,
            error: errorMessage(exc),
          });
          flashStatusBanner("✗ 对话流中断，可在消息卡上重试");
        }
      }
      setStreaming(false);
      unregisterActiveChat(abort);
      abortRef.current = null;
    },
    [
      appendMessage,
      cancelPendingFlush,
      flashStatusBanner,
      handleEvent,
      setPendingAsk,
      setStreaming,
      setSyncState,
      updateMessage,
      updateLastAgent,
    ],
  );

  /** 重试最近一次失败的消息（不重复追加用户消息）。 */
  const retryLast = useCallback(
    () => send(lastSentRef.current, { skipAppendUser: true }),
    [send],
  );

  /** 停止当前流（DSH 发送钮运行中变停止钮）。 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, retryLast, stop };
}
