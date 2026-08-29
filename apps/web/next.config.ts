import type { NextConfig } from "next";

/**
 * FL-21/FL-35：双阶段配置。
 * - `next dev`：`/api/*` 经 rewrites 反代到 StudyClaw 后端（`studyclaw serve`，
 *   默认 127.0.0.1:8080，可用 STUDYCLAW_API_URL 覆盖）——该代理目标仅存在于
 *   开发服务器，token 由 layout.tsx 从 host.json 运行期读取注入，不进产物；
 * - `next build`：`output: 'export'` 纯静态导出（out/），由 `studyclaw serve`
 *   同端口托管（static-host.ts）——UI 与 API 同源，不再需要任何代理层，
 *   构建期常量后端地址的 FL-35 问题随之消失。
 * rewrites 与 output:'export' 互斥，因此按 phase 显式二选一。
 */
const PHASE_DEVELOPMENT_SERVER = "phase-development-server";

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const backend = process.env.STUDYCLAW_API_URL ?? "http://127.0.0.1:8080";
    return {
      devIndicators: false,
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
      },
    };
  }
  return {
    devIndicators: false,
    output: "export",
    images: { unoptimized: true },
  };
}
