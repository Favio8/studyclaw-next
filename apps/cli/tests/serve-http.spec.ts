/**
 * serve 主循环集成覆盖（历史缺口：bin.ts 的 HTTP 边界此前只有单测，无任何
 * 集成用例触达）。以子进程起真实 serve（tsx 源码形态，--port 0 随机端口，
 * 临时 STUDYCLAW_HOME + STUDYCLAW_WEB_DIST），断言：
 *   1. /api/health 免 token 可达；
 *   2. RPC 无 token / 错 token → 401，正确 token → 200（门禁顺序）；
 *   3. 恶意 Origin → 403（先于 token 判定）；
 *   4. GET /api/* → 405（方法守卫）；
 *   5. 静态托管：/ 注入 token tap、无扩展名路由 SPA 回落、编码穿越不泄漏；
 *   6. 上传路由边界：无工作区 → 409（先于 busboy 解析）；
 *   7. C-1 回归：优雅关停（SIGINT）后 host.json 与 host.lock 真正删除；
 *   8. 实例锁自愈：同一 home 下强杀残留 lock 后重启可抢回。
 *
 * 平台注意（POSIX）：tsx CLI 与它拉起的 bin.ts 是两个进程，`child.kill()`
 * 只打到 wrapper 上。因此 POSIX 下 spawn 用 `detached` 让 serve 自成进程组，
 * 信号按组发（`process.kill(-pid, sig)`），保证真正跑 serve 的进程收到；
 * Windows 无进程组语义，`child.kill()` 即强杀且实测会带走监听（无孤儿）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const baseTsconfig = resolve(repoRoot, "tsconfig.base.json");
const binTs = join(repoRoot, "apps", "cli", "src", "bin.ts");

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const isWin = process.platform === "win32";

interface HostHandle {
  child: ChildProcess;
  home: string;
  dist: string;
  port: number;
  token: string;
  /** 真正跑 serve 的进程 pid（host.json 记录的是 bin.ts 的 pid）。 */
  pid: number;
}

const homes: string[] = [];

async function startHost(reuseHome?: string): Promise<HostHandle> {
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), "studyclaw-serve-it-"));
  if (reuseHome === undefined) homes.push(home);
  const dist = join(home, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html><head><meta charset=\"utf-8\"></head><body>sc-ui</body></html>", "utf8");
  writeFileSync(join(dist, "app.js"), "console.log('sc')\n", "utf8");
  // 复用同一 home（实例锁自愈用例）时，上一实例强杀残留的 host.json 会让就绪
  // 轮询立刻读到陈旧端口/token——先删掉，只认新实例写的那份。
  rmSync(join(home, "host.json"), { force: true });
  const child = spawn(process.execPath, [tsxCli, "--tsconfig", baseTsconfig, binTs, "serve", "--port", "0"], {
    env: { ...process.env, STUDYCLAW_HOME: home, STUDYCLAW_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX：serve 自成进程组，后续才能整组收信号（见文件头说明）。
    ...(isWin ? {} : { detached: true }),
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
        const cfg = JSON.parse(readFileSync(hostJsonPath, "utf8")) as { port?: number; token?: string | null; pid?: number };
        if (typeof cfg.port === "number" && typeof cfg.token === "string" && typeof cfg.pid === "number") {
          return { child, home, dist, port: cfg.port, token: cfg.token, pid: cfg.pid };
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

/** 强杀整棵 serve 进程树（不留清理机会）：POSIX 杀进程组，Windows 杀 wrapper。 */
function killHard(h: HostHandle): void {
  if (isWin) {
    h.child.kill();
    return;
  }
  try {
    process.kill(-h.child.pid, "SIGKILL");
  } catch {
    h.child.kill("SIGKILL");
  }
}

/** 优雅信号：POSIX 直发真正跑 serve 的进程（host.json 的 pid），Windows 直接强杀。
 *  不依赖 tsx wrapper 的信号中继——wrapper 自己收到 SIGINT 会先退，内层的清理
 *  时序不该押在 wrapper 的存活上；组信号只作内层已消失时的兜底。 */
function signalGracefully(h: HostHandle, signal: "SIGINT" | "SIGTERM"): void {
  if (isWin) {
    h.child.kill();
    return;
  }
  try {
    process.kill(h.pid, signal);
    return;
  } catch {
    // 内层已退或不可信号：退回进程组。
  }
  try {
    process.kill(-h.child.pid, signal);
  } catch {
    h.child.kill(signal);
  }
}

function stop(h: HostHandle | undefined): void {
  if (h === undefined) return;
  if (h.child.exitCode === null && h.child.signalCode === null) killHard(h);
}

async function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", done);
      reject(new Error(`子进程 ${child.pid} 未在 ${timeoutMs}ms 内退出`));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
  });
}

/** 轮询等文件消失（优雅关停的清理可能在 wrapper 退出之后才落盘）。 */
async function waitForGone(path: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** 读锁里的 pid；锁同样非原子写入，半写状态重试几次。 */
async function readLockPid(home: string): Promise<number> {
  for (let i = 0; i < 20; i += 1) {
    try {
      const raw = JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { pid?: number };
      if (typeof raw.pid === "number" && raw.pid > 0) return raw.pid;
    } catch {
      // 半写状态：稍等再试。
    }
    await sleep(100);
  }
  return 0;
}

let host: HostHandle | undefined;

beforeAll(async () => {
  host = await startHost();
}, 60_000);

afterAll(() => {
  stop(host);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${host!.port}`;
const auth = (token: string | null = host!.token): Record<string, string> => ({
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
    expect(html).toContain(host!.token);

    const spa = await fetch(`${base()}/some/deep/route`, { signal: AbortSignal.timeout(8_000) });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("sc-ui");

    const js = await fetch(`${base()}/app.js`, { signal: AbortSignal.timeout(8_000) });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  }, 15_000);

  it("编码穿越不泄漏文件内容（403 或被归一化为 SPA 回落）", async () => {
    // 实测两种服务端形态都安全：
    //  - `%2e%2e` 被 WHATWG URL 解析器在客户端归一化成 `/etc/passwd`，落 dist
    //    根内无此文件 → SPA 回落 200（index.html，无穿越目标内容）；
    //  - `..%2f` / `%2e%2e%2f` 保留编码到达服务端 → 显式 403。
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(8_000) });
      const body = await res.text();
      // 任何形态都不得带出穿越目标的文件内容。
      expect([200, 400, 403]).toContain(res.status);
      expect(body).not.toContain("root:");
      if (res.status === 200) expect(body).toContain("sc-ui");
    }
  }, 15_000);

  it("上传路由：无工作区 → 409（先于 busboy 解析）", async () => {
    const res = await fetch(`${base()}/api/courses/it-course/sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${host!.token}`, "content-type": "multipart/form-data; boundary=----x" },
      body: "------x--",
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(409);
  }, 15_000);
});

describe("serve 关停与实例锁", () => {
  it("C-1 回归：优雅关停后 host.json 与 host.lock 均被删除", async () => {
    if (isWin) return; // Windows 无信号语义，SIGINT 被映射为强杀
    const target = host!;
    const exiting = waitForExit(target.child);
    signalGracefully(target, "SIGINT");
    await exiting;
    expect(await waitForGone(join(target.home, "host.json"))).toBe(true);
    expect(await waitForGone(join(target.home, "host.lock"))).toBe(true);
  }, 30_000);

  it("实例锁自愈：同一 home 下强杀残留 lock 后重启可抢回", async () => {
    // 专用实例：关停用例已把共享实例优雅关停（lock 已删），不能复用它的 home。
    const stale = await startHost();
    try {
      const up = await fetch(`http://127.0.0.1:${stale.port}/api/health`, { signal: AbortSignal.timeout(8_000) });
      expect(up.status).toBe(200);
      const stalePidBefore = await readLockPid(stale.home);
      expect(stalePidBefore).toBeGreaterThan(0);

      const exiting = waitForExit(stale.child);
      killHard(stale);
      await exiting;
      // 强杀跳过清理：lock 残留，且锁里的 pid 已随进程消失。
      expect(existsSync(join(stale.home, "host.lock"))).toBe(true);
      const stalePid = await readLockPid(stale.home);
      expect(stalePid).toBe(stalePidBefore);

      // 同一 home 重启：acquireHostInstanceLock 发现陈旧 pid → 抢走锁并起服务。
      const second = await startHost(stale.home);
      try {
        const health = await fetch(`http://127.0.0.1:${second.port}/api/health`, { signal: AbortSignal.timeout(8_000) });
        expect(health.status).toBe(200);
        // 锁已易主（不是残留的旧 pid）——这条才是"自愈"的实质断言。
        expect(await readLockPid(stale.home)).not.toBe(stalePid);
      } finally {
        stop(second);
      }
    } finally {
      // 断言失败也要收掉这个专用实例，别把 serve 进程留给后续测试/CI。
      stop(stale);
    }
  }, 60_000);
});
