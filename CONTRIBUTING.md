# 贡献指南

感谢关注 StudyClaw！无论是报 Issue、提建议还是交代码，都欢迎。
开始之前，请花五分钟读完本指南，能省下彼此大量来回。

## 行为与安全

- 参与社区请遵守 [行为准则](./CODE_OF_CONDUCT.md)。
- **安全问题不要开公开 Issue**，走 [私密安全上报](./SECURITY.md)。

## 开发环境

| 依赖 | 要求 |
| --- | --- |
| Node.js | `^22.19.0` 或 `>=24` |
| pnpm | 11.7+（推荐 `corepack enable` 启用，版本由 `packageManager` 字段钉死） |
| 平台 | Windows / macOS / Linux（当前主力验证平台为 Windows，其余平台欢迎反馈） |

```bash
git clone <your-fork-url> studyclaw && cd studyclaw
pnpm install          # koffi（原生 FFI）需要可用的构建/预编译环境
pnpm build:web        # 前端静态导出到 apps/web/out
pnpm serve --open     # 启动本地 Host（默认 127.0.0.1:8080）
```

> corepack 损坏或被安全软件拦截时，直接用仓库内二进制兜底：
> `node_modules/.bin/tsx --tsconfig tsconfig.base.json apps/cli/src/bin.ts serve`、
> `node_modules/.bin/vitest run`、`node_modules/.bin/tsc -b tsconfig.json`。

### 热更新开发模式（两个终端）

```bash
pnpm serve                       # 终端 A：后端 Host（:8080）
cd apps/web && pnpm dev          # 终端 B：前端 dev server（:3000，/api/* 反代到 8080）
```

## 测试与质量门禁

```bash
pnpm typecheck   # 全 project references 图类型检查，必须零错误
pnpm test        # 后端 + Web 全部测试（默认超时已内置为 60s，与 CI 同口径）
```

- 测试共 1000+ 用例（单元 / jsdom 组件 / HTTP·SSE 集成）。极慢的机械盘上若仍见 I/O 超时假红，可加
  `-- --testTimeout=120000 --hookTimeout=120000` 再跑；单独重跑该文件也必然通过的即为假红。
- CI 另有三道门禁：tsc 误发射守卫、`next build` 静态导出、发布链路「打包 → 真装 → 真跑 `--help`」。

## 仓库导览

- [README](./README.md)：功能全景、架构图、CLI 命令参考、数据存放位置
- [docs/LEARNING_FLOW.md](./docs/LEARNING_FLOW.md)：学习闭环数据流与各面板数据来源
- [apps/web/AGENTS.md](./apps/web/AGENTS.md)：前端目录的组件/状态层约定

分层规则（详见 README「架构」）：

```
apps/web（Next.js 静态导出）
  └─ apps/cli + packages/host（HTTP/RPC/SSE 门面、编排）
       └─ packages/* 领域包（session / agent / tools / course / learning / llm / storage / settings …）
```

- 领域包不直接碰 HTTP 传输层；跨包只依赖明确的导出边界。
- 学习状态一律走「文件即状态」契约（`syllabus.json` / `progress.md` / `tasks/` / `history/`），**不引入数据库服务**。
- 改动领域契约（RPC 方法、文件格式、事件类型）必须同步补测试；新增 RPC 方法需在 `apiproxy` 补 zod 校验与错误码。

## 提交规范

遵循 Conventional Commits，格式 `emoji type(scope): description`（英文描述，与仓库历史一致）。
仓库在用的 emoji 对照：

| emoji | 类型 | emoji | 类型 |
| --- | --- | --- | --- |
| ✨ | feat 新功能 | 🐛 | fix 缺陷修复 |
| 📝 | docs 文档 | 🧱 🏗️ | chore/eng 工程与构建 |
| ⚡ | perf 性能 | 🔒 | security/chore 安全加固 |

示例：`✨ feat(learning): variant cards for misconception retry`、`🐛 fix(host): guard course mismatch in chat stream`。

## 提交 PR

1. 从 `main` 拉出功能分支，小步提交，保持每个提交可独立通过 typecheck。
2. PR 描述说清动机、方案与影响面，按模板勾选自查清单。
3. 确保 CI 四个 Job 全绿；UI 改动附截图/录屏。
4. 一次 PR 尽量只做一件事；顺手修的无关问题请另开 PR。

## 报 Issue 的技巧

- 使用 Issue 模板：附上操作系统、Node 版本、`studyclaw status` 输出与 `~/.studyclaw/logs/` 相关日志（**先脱敏**）。
- 环境类问题（安装失败、端口占用、模型连不上）先查 README FAQ 与 Discussions 置顶帖。
- 会话相关的 bug 最好附上出问题的会话 JSONL 片段（删掉个人内容后）。
