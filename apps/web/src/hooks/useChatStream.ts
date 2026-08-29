"use client";

/**
 * 中栏对话流编排（T3.3，api_spec §3.1）。
 *
 * send(text)：
 * 1. 指令拦截（`/xxx` 命令前缀走 `lib/commands.ts`，兼容旧 `:xxx`）；
 * 2. 用户消息入 store + agent 占位（streaming）→ SSE 消费事件流；
 * 3. meta：同步真实 sessionId（无对话时服务端自动新建）+ 刷新左栏对话列表；
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
 * 对话切换/新建由 useSessionActions 调 abortActiveChat() 中止旧流；
 * isAbortError 不触发重试。
 */

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/src/lib/api";
import {
  isAbortError,
  registerActiveChat,
  streamAgentAnswer,
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
  // 吉祥物（爪爪）流式相位：thinking/token 帧写入，全部终态清空
  const setStreamPhase = useAppStore((s) => s.setStreamPhase);
  // 工具执行计数：tool-start +1 / tool -1，驱动爪爪 searching 态
  const adjustToolRunning = useAppStore((s) => s.adjustToolRunning);
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
  const sendRef = useRef<(text: string, opts?: { skipAppendUser?: boolean; queuedTurnId?: string }) => Promise<void>>(() => Promise.resolve());
  /** FE-1：SSE 业务 error 帧 → 终态标记，绝不进入网络重试循环。 */
  const streamErrorRef = useRef<string | null>(null);
  /** FE-4：done 后延迟刷新的定时器句柄，卸载时统一清理。 */
  const deferredTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (abortRef.current) abortRef.current.abort();
      for (const timer of deferredTimersRef.current) clearTimeout(timer);
      deferredTimersRef.current.clear();
    },
    [],
  );

  /** setTimeout 包装：记录句柄、触发后自清，卸载统一取消。 */
  const scheduleDeferred = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      deferredTimersRef.current.delete(timer);
      fn();
    }, ms);
    deferredTimersRef.current.add(timer);
  }, []);

  /** FE-2 队列归属守卫：只有"发起排队时的会话"仍处于激活状态才允许发送下一条，
   * 否则丢弃并提示——修复 abort 走成功出口把旧会话文本发进新会话的串课。 */
  const ownerRef = useRef<{ courseId: string | null; sessionId: string | null }>({ courseId: null, sessionId: null });

  const drainQueueIfOwned = useCallback(() => {
    const state = useAppStore.getState();
    const next = state.shiftQueuedMessage();
    if (next === undefined) return;
    const owner = ownerRef.current;
    const sameOwner = (state.activeCourseId ?? null) === owner.courseId
      && (state.activeSessionId ?? null) === owner.sessionId;
    if (!sameOwner) {
      flashStatusBanner("已切换会话，丢弃旧队列消息");
      return;
    }
    scheduleDeferred(() => { void sendRef.current(next.text, { queuedTurnId: next.turnId }); }, 0);
  }, [flashStatusBanner, scheduleDeferred]);

  const refreshSessions = useCallback(
    async (courseId: string, sessionId?: string) => {
      try {
        const { sessions } = await api.sessions(courseId);
        setSessions(sessions);
        useAppStore.getState().setCourseSessions(courseId, sessions);
        // 同步激活对话标题：发送时落盘的 session/title 让面包屑脱离「新对话」。
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
          const { sessionId, model, provider, effort } = ev.data;
          const state = useAppStore.getState();
          if (model) {
            // 模型座位数据源（api_spec §3.1 v2.6）：本轮实际生效的 provider/model
            state.setActiveModel({ providerId: provider ?? "", model, ...(effort === undefined ? {} : { effort }) });
          }
          if (sessionId && sessionId !== state.activeSessionId) {
            // 无对话发送时服务端自动新建：更新激活对话但保留流式消息
            setActiveSession(sessionId, "");
            const courseId = state.activeCourseId;
            if (courseId) void refreshSessions(courseId);
            // FE-2：首条消息动态建会话 → 归属快照同步更新，队列仍属本会话。
            if (ownerRef.current.sessionId === null) ownerRef.current.sessionId = sessionId;
          }
          break;
        }
        case "thinking": {
          thinkingRef.current += ev.data.delta;
          // 爪爪进入思考姿态
          setStreamPhase("thinking");
          if (thinkingStartRef.current === null) {
            thinkingStartRef.current = performance.now();
          }
          scheduleFlush();
          break;
        }
        case "token": {
          contentRef.current += ev.data.delta;
          // 首个正文 token 起：爪爪切到打字姿态
          setStreamPhase("writing");
          scheduleFlush();
          break;
        }
        case "tool-start": {
          toolsRef.current = [
            ...toolsRef.current,
            {
              callId: ev.data.callId,
              name: ev.data.name,
              status: "running",
              args: ev.data.args,
              summary: "执行中…",
              error: null,
              durationMs: null,
            },
          ];
          // 爪爪 searching 态：工具有执行中的了
          adjustToolRunning(1);
          scheduleFlush();
          break;
        }
        case "tool": {
          const callId = ev.data.callId;
          const index = callId === undefined
            ? -1
            : toolsRef.current.findIndex((tool) => tool.callId === callId);
          if (index >= 0) {
            const next = toolsRef.current.slice();
            next[index] = ev.data;
            toolsRef.current = next;
          } else {
            toolsRef.current = [...toolsRef.current, ev.data];
          }
          // 终态工具帧：计数回落（未配对的 tool 帧防御性不增）
          if (index >= 0) adjustToolRunning(-1);
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
          // 流式正常收尾：爪爪退出 thinking/writing 姿态
          setStreamPhase(null);
          useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零
          // 完成即刷新左栏：turns 与标题（发送时已落盘的 session/title）立即可见；
          // LLM 智能标题稍后落盘，延迟再静默刷一次（无推送通道，不改 SSE 协议）。
          {
            const state = useAppStore.getState();
            const courseId = state.activeCourseId;
            if (courseId) {
              const sessionId = state.activeSessionId;
              void refreshSessions(courseId, sessionId || undefined);
              // FE-4：定时器登记句柄，卸载统一清理，不再卸载后 setState。
              scheduleDeferred(() => {
                void refreshSessions(useAppStore.getState().activeCourseId ?? courseId, useAppStore.getState().activeSessionId || undefined);
              }, 3000);
            }
          }
          break;
        }
        case "error": {
          // FE-1：服务端业务错误（限流/配额/工具失败）是终态——旧的 throw 进
          // 网络重试循环导致整轮最多重发 3 次（副作用×3、费用×3）。标记后由
          // send 循环直接收尾，不做任何重试。
          streamErrorRef.current = `${ev.data.code}: ${ev.data.message}`;
          cancelPendingFlush();
          updateLastAgent({ streaming: false, error: streamErrorRef.current });
          setSyncState("synced");
          setStreamPhase(null);
          useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 爪爪退出流式姿态（alerting 由 error 派生）
          flashStatusBanner("✗ 服务端返回错误，已停止本回合（未重试）");
          break;
        }
        default: {
          /* 未知事件类型：契约外，忽略 */
        }
      }
    },
    [adjustToolRunning, cancelPendingFlush, flashStatusBanner, refreshPanel, refreshSessions, scheduleDeferred, scheduleFlush, setActiveSession, setLastTurnId, setPendingAsk, setStreamPhase, setSyncState, updateLastAgent],
  );

  const send = useCallback(
    async (text: string, opts?: { skipAppendUser?: boolean; queuedTurnId?: string }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (useAppStore.getState().streaming && !opts?.queuedTurnId) {
        const state = useAppStore.getState();
        if (state.queuedMessages.length >= 20) {
          flashStatusBanner("队列已满，请等待当前回合完成");
          return;
        }
        if (state.activeSessionId) {
          try {
            const queued = await api.enqueueAgent(state.activeCourseId ?? "", state.activeSessionId, state.mode, trimmed);
            state.enqueueQueuedMessage({ text: trimmed, turnId: queued.turnId });
          } catch {
            state.enqueueQueuedMessage({ text: trimmed });
          }
        } else state.enqueueQueuedMessage({ text: trimmed });
        flashStatusBanner(`已加入队列 · ${useAppStore.getState().queuedMessages.length}`);
        return;
      }

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
      streamErrorRef.current = null;
      // FE-2：记录本回合的归属（项目+会话），drain 队列前比对。
      ownerRef.current = { courseId: courseId ?? null, sessionId: sessionId ?? null };

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          // 重试：占位先清空（重放或重流都会重新填充）
          contentRef.current = "";
          thinkingRef.current = "";
          thinkingStartRef.current = null;
            toolsRef.current = [];
          updateLastAgent({ content: "", thinking: "", streaming: true });
        }
        let abortedMidStream = false;
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
              turnId: opts?.queuedTurnId ?? null,
            },
            abort.signal,
          )) {
            if (abort.signal.aborted) { abortedMidStream = true; break; }
            handleEvent(ev);
            // FE-1：业务 error 帧是终态，立刻退出事件循环且不计入网络重试。
            if (streamErrorRef.current !== null) break;
          }
          if (abort.signal.aborted) abortedMidStream = true;
          if (abortedMidStream) {
            // 用户停止/切换对话：定格占位卡并退出；FE-2：不 drain 队列。
            cancelPendingFlush();
            updateLastAgent({ streaming: false });
            setStreamPhase(null);
            useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 爪爪退出流式姿态
            break;
          }
          if (streamErrorRef.current !== null) {
            // FE-1 终态失败：不重试。消息卡错误已在 error 分支写入。
            // 此前漏了清全局流式态——shimmer 行和输入框会永久卡在"生成中"。
            cancelPendingFlush();
            setStreaming(false);
            setStreamPhase(null);
            useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零
            unregisterActiveChat(abort);
            abortRef.current = null;
            return;
          }
          // 成功完成：收尾（done 已定格消息卡，此处清全局流态）
          cancelPendingFlush();
          setStreaming(false);
          setStreamPhase(null);
          useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 兜底：任何退出路径都不残留爪爪流式相位
          unregisterActiveChat(abort);
          abortRef.current = null;
          drainQueueIfOwned();
          return;
        } catch (exc) {
          if (isAbortError(exc) || abort.signal.aborted) {
            // 用户停止/切换对话：定格占位卡（切换方随后可能清空消息）；
            // FE-2：不走 drain——旧会话的排队文本绝不能发进当前会话。
            cancelPendingFlush();
            updateLastAgent({ streaming: false });
            setStreamPhase(null);
            useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 爪爪退出流式姿态
            abortRef.current = null;
            setStreaming(false);
            unregisterActiveChat(abort);
            return;
          }
          if (attempt < MAX_ATTEMPTS - 1) continue;
          cancelPendingFlush();
          updateLastAgent({
            streaming: false,
            error: errorMessage(exc),
          });
          flashStatusBanner("✗ 对话流中断，可在消息卡上重试");
          abortRef.current = null;
          break;
        }
      }
      setStreaming(false);
      setStreamPhase(null);
      useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 循环穷尽（重试耗尽等）同样不残留相位
      unregisterActiveChat(abort);
      abortRef.current = null;
    },
    [
      appendMessage,
      cancelPendingFlush,
      flashStatusBanner,
      handleEvent,
      setPendingAsk,
      setStreamPhase,
      setStreaming,
      setSyncState,
      updateMessage,
      updateLastAgent,
    ],
  );

  /** Answer the pending Agent ask without creating a second ordinary turn. */
  const answer = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    const state = useAppStore.getState();
    const sessionId = state.activeSessionId;
    if (!trimmed || !sessionId || !state.pendingAsk || state.streaming) return false;
    appendMessage({ id: nextMessageId(), role: "user", content: trimmed, createdAt: new Date().toISOString() });
    appendMessage({ id: nextMessageId(), role: "agent", content: "", thinking: "", createdAt: new Date().toISOString(), streaming: true, mode: state.mode });
    const abort = new AbortController();
    abortRef.current = abort;
    registerActiveChat(abort);
    setStreaming(true);
    setSyncState("synced");
    contentRef.current = "";
    thinkingRef.current = "";
    thinkingStartRef.current = null;
    toolsRef.current = [];
    let accepted = false;
    try {
      for await (const ev of streamAgentAnswer(`study-${sessionId}`, trimmed, abort.signal)) {
        if (abort.signal.aborted) break;
        if (ev.event === "meta") {
          accepted = true;
          setPendingAsk(null);
        }
        handleEvent(ev);
      }
      cancelPendingFlush();
      updateLastAgent({ content: contentRef.current, thinking: thinkingRef.current, ...(toolsRef.current.length ? { tools: toolsRef.current.slice() } : {}), streaming: false });
      setStreaming(false);
      setStreamPhase(null);
      useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 爪爪退出流式姿态
      unregisterActiveChat(abort);
      abortRef.current = null;
      drainQueueIfOwned();
      return accepted;
    } catch (exc) {
      cancelPendingFlush();
      updateLastAgent({ streaming: false, error: errorMessage(exc) });
      flashStatusBanner("✗ 回答未送达，可重试");
      setStreaming(false);
      setStreamPhase(null);
      useAppStore.setState({ toolRunning: 0 }); // 爪爪 searching 计数归零 // 爪爪退出流式姿态
      unregisterActiveChat(abort);
      abortRef.current = null;
      return false;
    }
  }, [appendMessage, cancelPendingFlush, flashStatusBanner, handleEvent, setPendingAsk, setStreamPhase, setStreaming, setSyncState, updateLastAgent]);

  /** 重试最近一次失败的消息（不重复追加用户消息）。 */
  const retryLast = useCallback(
    () => send(lastSentRef.current, { skipAppendUser: true }),
    [send],
  );
  sendRef.current = send;

  /** 停止当前流（DSH 发送钮运行中变停止钮）。 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, answer, retryLast, stop };
}
