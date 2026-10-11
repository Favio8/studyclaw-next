import { describe, expect, it, vi, afterEach } from "vitest";
import { streamSse } from "../src/lib/api";

/**
 * streamSse 的响应体生命周期（Web Streams 契约）。
 *
 * 回归：调用方可以随时 break——收到 error 帧、用户关掉阅读动作卡、切走面板。
 * 生成器的 .return() 只结束本函数，旧实现没有 finally，于是 reader 既不被
 * cancel 也不 releaseLock：底层连接保持打开，**服务端还会继续把 token 推完**
 * （真金白银的 LLM 费用），浏览器连接池也会被慢慢占满。
 *
 * 实测旧实现 cancels=0。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 永不关闭的 SSE 流，模拟持续推流。 */
function endlessStream(): { stream: ReadableStream<Uint8Array>; cancels: () => number } {
  let cancelCount = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: token\ndata: {"a":1}\n\n'));
      controller.enqueue(encoder.encode('event: token\ndata: {"a":2}\n\n'));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  return { stream, cancels: () => cancelCount };
}

function stubFetch(stream: ReadableStream<Uint8Array>): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
}

describe("streamSse 响应体生命周期", () => {
  it("消费者提前 break 时取消响应体", async () => {
    const { stream, cancels } = endlessStream();
    stubFetch(stream);

    const seen: unknown[] = [];
    for await (const frame of streamSse<{ event: string; data: unknown }>("/api/x", {})) {
      seen.push(frame);
      if (seen.length >= 1) break;
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(1);
    expect(cancels(), "提前退出必须取消响应体，否则服务端继续推流").toBe(1);
  });

  it("读到 error 帧后提前退出同样取消响应体", async () => {
    let cancelCount = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: error\ndata: {"code":"X"}\n\n'));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    stubFetch(stream);

    for await (const frame of streamSse<{ event: string; data: { code?: string } }>("/api/x", {})) {
      if (frame.event === "error") break;
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(cancelCount).toBe(1);
  });

  it("正常读完也会释放（cancel 对已结束流是空操作，不应报错）", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: token\ndata: {"a":1}\n\n'));
        controller.close();
      },
      cancel() {
        // 读完不应触发
      },
    });
    stubFetch(stream);

    const seen: string[] = [];
    for await (const frame of streamSse<{ event: string }>("/api/x", {})) seen.push(frame.event);

    expect(seen).toEqual(["token"]);
  });

  it("中途抛错也释放响应体", async () => {
    let cancelCount = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: token\ndata: {"a":1}\n\n'));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    stubFetch(stream);

    await expect(async () => {
      for await (const _frame of streamSse<{ event: string }>("/api/x", {})) {
        throw new Error("调用方处理失败");
      }
    }).rejects.toThrow("调用方处理失败");
    await new Promise((r) => setTimeout(r, 10));

    expect(cancelCount).toBe(1);
  });
});