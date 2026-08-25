import type { NextConfig } from "next";

/**
 * /api/* 反向代理到 StudyClaw 后端（T2.5 FastAPI，默认 127.0.0.1:8080）。
 * 前端一律请求相对路径 `/api/...`，规避 CORS；后端地址可用环境变量
 * STUDYCLAW_API_URL 覆盖（如容器化部署）。
 */
const backend =
  process.env.STUDYCLAW_API_URL ?? "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  turbopack: {
    root: "D:/AAA_Favio/AI_exploring/projects/studyclaw-ai/studyclaw-next",
  },
  // Keep the Next.js development error indicator out of the product shell.
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
