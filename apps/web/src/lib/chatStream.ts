/**
 * 对话流式客户端（T3.3）：POST /api/chat/stream（SSE）+ 活跃流中止单例。
 *
 * - 复用 `api.ts` 的 streamSse 帧解析（event/data/id 行）；
 * - `Last-Event-ID` 头：断线重连时重放服务端已落盘轮次的正文（t_NN），
 *   未落盘则服务端重新生成流（见 server app.py chat_stream/ replay）；
 * - 模块级活跃流句柄：对话切换 / 新建前必须先 abortActiveChat()，
 *   保证同一时刻仅一条活跃流（旧流不残留、不互相串流）。
 */

import { streamSse } from "@/src/lib/api";
import type { ChatEvent } from "@/src/types/api";

export interface StreamChatArgs {
  courseId: string;
  message: string;
  mode: string;
  sessionId?: string | null;
  conceptId?: string | null;
  /** 当前课程根目录下的相对文件引用。 */
  fileRefs?: string[];
  /** Last-Event-ID：断线重连重放已落盘轮次正文（t_NN）。 */
  lastEventId?: string | null;
  /** Existing durable Agent turn to consume (used by the inbox queue). */
  turnId?: string | null;
  /** UI-1 幂等键：客户端在重试循环内复用同一值，服务端据此重放/跟随已落盘 turn
   * 而非新开（避免断线重试产生重复 user/input 与重复计费）。 */
  requestId?: string | null;
}

export async function* streamChat(
  args: StreamChatArgs,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const headers: Record<string, string> = {};
  if (args.lastEventId) headers["Last-Event-ID"] = args.lastEventId;
  yield* streamSse<ChatEvent>(
    "/api/chat/stream",
    {
      courseId: args.courseId,
      message: args.message,
      mode: args.mode,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.conceptId ? { conceptId: args.conceptId } : {}),
      ...(args.fileRefs?.length ? { fileRefs: args.fileRefs } : {}),
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.requestId ? { requestId: args.requestId } : {}),
    },
    headers,
    signal,
  );
}

/** Resume a durable ask-user turn through the Agent answer transport.
 * UI-14：携带 requestId 幂等键——网络中断后用同一键重试，服务端 attach
 * 已落盘 turn 重放，而不是报"没有待回答的问题"。 */
export async function* streamAgentAnswer(
  agentId: string,
  answer: string,
  signal?: AbortSignal,
  requestId?: string | null,
): AsyncGenerator<ChatEvent> {
  yield* streamSse<ChatEvent>(
    "/api/agents/answer/stream",
    { agentId, answer, ...(requestId ? { requestId } : {}) },
    undefined,
    signal,
  );
}

/** 模块级「当前活跃流」中止句柄（单例：同一时刻仅一条活跃流）。 */
let activeAbort: AbortController | null = null;

/** 注册本轮的 AbortController（抢占式：自动中止上一轮残留）。 */
export function registerActiveChat(abort: AbortController): void {
  abortActiveChat();
  activeAbort = abort;
}

/** 若 handle 仍是最新活跃流则注销（done/最终失败/显式中止后调用）。 */
export function unregisterActiveChat(abort: AbortController): void {
  if (activeAbort === abort) activeAbort = null;
}

/** 中止当前活跃流（对话切换 / 新建 / 组件卸载）。 */
export function abortActiveChat(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/** AbortError 判定（中止引起的读取拒绝不是流错误，不触发重试）。 */
export function isAbortError(exc: unknown): boolean {
  return (
    exc instanceof DOMException && exc.name === "AbortError"
  ) || (exc instanceof Error && exc.name === "AbortError");
}
