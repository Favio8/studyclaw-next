# StudyClaw Web 控制台

> 当前维护项目 `studyclaw-next` 的前端，使用 Next.js 16 / React 19。开发约定见 [AGENTS.md](AGENTS.md) 和 [仓库协作规范](../../AGENTS.md)。

## 开发

在 `studyclaw-next/` 根目录安装依赖并启动本地 Host：

```powershell
pnpm install
pnpm serve
```

在另一终端从同一仓库根运行：

```powershell
pnpm --filter web dev
```

访问 `http://localhost:3000`。开发时 `next.config.ts` 将 `/api/*` 代理到 `http://127.0.0.1:8080`；如 Host 使用其他地址，可在启动 Web 前设置 `STUDYCLAW_API_URL`。认证 token 由开发布局读取 Host 元数据并注入。

## 构建与检查

以下命令在仓库根运行：

```powershell
pnpm typecheck
pnpm --filter web lint
pnpm --filter web test
pnpm build:web
```

生产构建使用 `output: "export"`，产物在 `apps/web/out/`。运行 `pnpm serve --open` 由本地 Host 同源托管静态页面与 API；部署使用该流程。

## 代码入口

- `app/`：页面、布局与主题样式。
- `src/components/`：会话、导航、面板与设置组件。
- `src/lib/api.ts`：Host RPC、SSE 与鉴权调用。
- `src/hooks/`、`src/store/`：交互与状态管理。
- `tests/`：Web 组件和交互测试；仓库根 `pnpm test` 同样包含 Web 测试项目。

功能与领域数据流见 [仓库 README](../../README.md) 和 [学习流程](../../docs/LEARNING_FLOW.md)。
