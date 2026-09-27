/**
 * serve 主循环集成覆盖（历史缺口：bin.ts 的 HTTP 边界此前只有单测，无任何
 * 集成用例触达）。以子进程起真实 serve（tsx 源码形态，--port 0 随机端口，
 * 临时 STUDYCLAW_HOME + STUDYCLAW_WEB_DIST），断言：
 *   1. /api/health 免 token 可达；
 *   2. RPC 无 token / 错 token → 401，正确 token → 200（门禁顺序）；
 *   3. 恶意 Origin → 403（先于 token 判定）；
 *   4. GET /api/* → 405（方法守卫）；
 *   5. 静态托管：/ 注入 token tap、无扩展名路由 SPA 回落、编码穿越 403；
 *   6. 上传路由边界：无工作区 → 409（先于 busboy 解析）；
 *   7. C-1 回归：优雅关停（SIGINT）后 host.json 与 host.lock 真正删除；
 *   8. 实例锁自愈：强杀残留 lock 后重启可抢走。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const binTs = join(repoRoot, "apps", "cli", "src", "bin.ts");

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface HostHandle {
  child: ChildProcess;
  home: string;
  dist: string;
  port: number;
  token: string;
}

const homes: string[] = [];

async function startHost(): Promise<HostHandle> {
  const home = mkdtempSync(join(tmpdir(), "studyclaw-serve-it-"));
  homes.push(home);
  const dist = join(home, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html><head><meta charset=\"utf-8\"></head><body>sc-ui</body></html>", "utf8");
  writeFileSync(join(dist, "app.js"), "console.log('sc')\n", "utf8");
  const child = spawn(process.execPath, [tsxCli, "--tsconfig", "tsconfig.base.json", binTs, "serve", "--port", "0"], {
    env: { ...process.env, STUDYCLAW_HOME: home, STUDYCLAW_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", d => { stderr += d });
  const hostJsonPath = join(home, "host.json");
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (existsSync(hostJsonPath)) {
      try {
        // host.json 由 writeFile 非原子写入——全量负载下轮询可能读到写了一半的
        // 文件，解析失败时下一轮再试（端口/token 就绪前不返回）。
        const cfg = JSON.parse(readFileSync(hostJsonPath, "utf8")) as { port?: number; token?: string | null };
        if (typeof cfg.port === "number" && typeof cfg.token === "string") {
          return { child, home, dist, port: cfg.port, token: cfg.token };
        }
      } catch {
        // 半写状态：继续轮询。
      }
    }
    await sleep(150);
  }
  child.kill();
  throw new Error(`serve 未在 40s 内就绪。stderr: ${stderr.slice(-800)}`);
}

function stop(h: HostHandle): void {
  if (h.child.exitCode === null) h.child.kill();
}

let host: HostHandle;

beforeAll(async () => {
  host = await startHost();
}, 60_000);

afterAll(() => {
  stop(host);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${host.port}`;
const auth = (token: string | null = host.token): Record<string, string> => ({
  "content-type": "application/json",
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
});

describe("serve HTTP 边界（集成）", () => {
  it("health 免 token 可达", async () => {
    const res = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(8_000) });
    expect(res.status).toBe(200);
  }, 15_000);

  it("RPC 无 token / 错 token → 401，正确 token → 200", async () => {
    const none = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: auth("wrong-token"), body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base()}/api/workspaces.list`, { method: "POST", headers: auth(), body: "{}", signal: AbortSignal.timeout(8_000) });
    expect(ok.status).toBe(200);
  }, 15_000);

  it("恶意 Origin → 403（先于 token 判定）", async () => {
    const res = await fetch(`${base()}/api/workspaces.list`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(403);
  }, 15_000);

  it("GET /api/* → 405（方法守卫）", async () => {
    const res = await fetch(`${base()}/api/workspaces.list`, { headers: auth(), signal: AbortSignal.timeout(8_000) });
    expect(res.status).toBe(405);
  }, 15_000);

  it("静态托管：token tap 注入、SPA 回落、资源 MIME", async () => {
    const page = await fetch(`${base()}/`, { signal: AbortSignal.timeout(8_000) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("window.__STUDYCLAW__");
    expect(html).toContain(host.token);

    const spa = await fetch(`${base()}/some/deep/route`, { signal: AbortSignal.timeout(8_000) });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("sc-ui");

    const js = await fetch(`${base()}/app.js`, { signal: AbortSignal.timeout(8_000) });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  }, 15_000);

  it("编码穿越不泄漏文件内容（403 或被归一化为 SPA 回落）", async () => {
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(8_000) });
      const body = await res.text();
      // 服务端两种形态都安全：显式拒绝（400/403），或被 WHATWG URL 解析器
      // 在客户端归一化后落到 dist 根内走 SPA 回落——任何形态都不得带出穿越
      // 目标的文件内容。
      expect([200, 400, 403]).toContain(res.status);
      expect(body).not.toContain("root:");
      if (res.status === 200) expect(body).toContain("sc-ui");
    }
  }, 15_000);

  it("上传路由：无工作区 → 409（先于 busboy 解析）", async () => {
    const res = await fetch(`${base()}/api/courses/it-course/sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "multipart/form-data; boundary=----x" },
      body: "------x--",
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(409);
  }, 15_000);
});

describe("serve 关停与实例锁", () => {
  it("C-1 回归：优雅关停后 host.json 与 host.lock 均被删除", async () => {
    if (process.platform === "win32") return; // Windows 无信号语义，SIGINT 被映射为强杀
    const exited = new Promise<number | null>(resolve => {
      host.child.once("exit", code => resolve(code));
    });
    host.child.kill("SIGINT");
    await exited;
    expect(existsSync(join(host.home, "host.json"))).toBe(false);
    expect(existsSync(join(host.home, "host.lock"))).toBe(false);
  }, 20_000);

  it("实例锁自愈：强杀残留 lock 后重启可抢回", async () => {
    if (process.platform === "win32") {
      host.child.kill(); // Windows kill 即强杀
    } else {
      host.child.kill("SIGKILL");
    }
    await sleep(500);
    // 强杀跳过清理：lock 与 host.json 残留，且 lock 里的 pid 已死。
    expect(existsSync(join(host.home, "host.lock"))).toBe(true);
    let stalePid = 0;
    for (let i = 0; i < 20 && stalePid === 0; i += 1) {
      try {
        stalePid = (JSON.parse(readFileSync(join(host.home, "host.lock"), "utf8")) as { pid: number }).pid;
      } catch {
        await sleep(100); // lock 同样可能处于半写状态
      }
    }
    expect(stalePid).toBeGreaterThan(0);

    const second = await startHost();
    try {
      expect(second.child.pid).not.toBe(stalePid);
      const health = await fetch(`http://127.0.0.1:${second.port}/api/health`, { signal: AbortSignal.timeout(8_000) });
      expect(health.status).toBe(200);
    } finally {
      stop(second);
    }
  }, 60_000);
});
