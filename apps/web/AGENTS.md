# StudyClaw Web 维护范围

本目录属于当前维护的 `studyclaw-next`，先阅读 [仓库 AGENTS.md](../../AGENTS.md) 和 [Web README](README.md)。旧项目 `studyclaw/web/` 已废弃。

开发服务器通过 `next.config.ts` 代理本地 Host；生产构建静态导出到 `out/` 并由 Host 托管。API/RPC 调用入口为 `src/lib/api.ts`，领域行为在 Host 和 `packages/` 维护。保留下面由 Next.js 管理的规则块。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
