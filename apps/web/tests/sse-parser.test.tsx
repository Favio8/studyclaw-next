/**
 * W-5 回归：SSE 帧解析对齐规范——
 * ① 多 data 行按规范用 \n 连接（旧实现 join("") 粘成坏帧）；
 * ② 单个坏 JSON 帧被跳过而非炸整条流（旧实现抛错并白耗 3 次网络重试）；
 * ③ 孤立 \r 作为行终止符（旧实现只处理 \r\n）；
 * ④ `field:value` 无空格形态（旧实现要求 "event: " 带空格）；
 * ⑤ 跨 chunk 的多字节 UTF-8 尾字节经 decoder flush 不丢失。
 */

import { describe, expect, it, vi } from "vitest";

import { streamSse } from "../src/lib/api";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => "" } as unknown as Response;
}

function mockFetch(chunks: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));
}

async function collect(): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for await (const frame of streamSse<{ event: string; data: Record<string, unknown> }>("/api/x", {})) out.push(frame);
  return out;
}

describe("streamSse 规范对齐（W-5）", () => {
  it("多 data 行按 \\n 连接后正确解析", async () => {
    mockFetch(['event: token\ndata: {"a":\ndata: 1}\n\n']);
    const frames = await collect();
    expect(frames).toEqual([{ event: "token", data: { a: 1 } }]);
  });

  it("单个坏 JSON 帧被跳过，后续帧不受影响", async () => {
    mockFetch(['event: bad\ndata: {oops\n\nevent: good\ndata: {"ok":true}\n\n']);
    const frames = await collect();
    expect(frames).toEqual([{ event: "good", data: { ok: true } }]);
  });

  it("孤立 \\r 作为行终止符（CRLF/CR/LF 混用）", async () => {
    mockFetch(["event: token\rdata: {\"a\":1}\r\r"]);
    const frames = await collect();
    expect(frames).toEqual([{ event: "token", data: { a: 1 } }]);
  });

  it("field:value 无空格形态可解析", async () => {
    mockFetch(["event:token\ndata:{\"a\":1}\n\n"]);
    const frames = await collect();
    expect(frames).toEqual([{ event: "token", data: { a: 1 } }]);
  });

  it("跨 chunk 的多字节 UTF-8 尾字节不丢失（decoder flush）", async () => {
    // "题" = E9 A2 98：故意切在两 chunk 之间。
    const encoder = new TextEncoder();
    const full = encoder.encode('event: token\ndata: {"q":"题"}\n\n');
    const cut = full.indexOf(0xe9);
    mockFetch([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(full.slice(0, cut));
            controller.enqueue(full.slice(cut));
            controller.close();
          },
        }),
      }) as unknown as Response),
    );
    const frames = await collect();
    expect(frames).toEqual([{ event: "token", data: { q: "题" } }]);
  });
});
