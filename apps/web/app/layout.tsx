import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "./globals.css";

export const metadata: Metadata = {
  title: "StudyClaw · 以测促学",
  description:
    "评测驱动、项目即课程、文件即状态的学习 Agent 控制台（DSH 风格）",
};

/**
 * FL-30：开发模式的 token 引导。生产路径由 `studyclaw serve` 在托管 index.html
 * 时通过 tap 注入（static-host.ts）；`next dev` 下浏览器与宿主跨端口，无法
 * 自行读取 host.json——这里在服务端渲染时读一次注入给客户端。仅在 dev 生效：
 * 静态导出（build）时 NODE_ENV=production，不会把任何 token 烧进产物。
 */
function devBootstrap(): { token?: string } | null {
  if (process.env.NODE_ENV !== "development") return null;
  try {
    const home = process.env.STUDYCLAW_HOME ?? join(homedir(), ".studyclaw");
    const parsed = JSON.parse(readFileSync(join(home, "host.json"), "utf8")) as {
      token?: string | null;
    };
    return typeof parsed.token === "string" && parsed.token !== "" ? { token: parsed.token } : null;
  } catch {
    return null;
  }
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  const bootstrap = devBootstrap();
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head>
        {bootstrap !== null ? (
          <script
            dangerouslySetInnerHTML={{ __html: `window.__STUDYCLAW__=${JSON.stringify(bootstrap)}` }}
          />
        ) : null}
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
