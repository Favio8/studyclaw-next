# AGENTS.md — StudyClaw 当前代码仓库

> 更新：2026-09-30。`studyclaw-next` 是唯一维护中的 StudyClaw 实现；同级 `studyclaw/` 已废弃。

## 术语约定

- **工作区**固定指上层 `studyclaw-ai/`；**当前仓库**固定指本仓库 `studyclaw-next/`；**旧仓库**指同级已废弃的 `studyclaw/`。
- 用户说「工作区」时按整个 `studyclaw-ai/` 定位，说「当前仓库」或「仓库根目录」时按 `studyclaw-next/` 定位。
- 完整工作区的过程文档集中在其 `docs/` 下，根目录只保留协作规则和导航；本仓库随版本维护的文档保留原位。独立克隆时不要求上层工作区存在。
- 产品或接口中的 Workspace 指用户的「学习项目工作区」，引用源码标识和历史原文时保留原有名称。

## 范围与流程

- 当前实现、修复、测试、脚本和依赖配置都在本仓库进行。
- 工作区上层目录存放构建、规划、决策与评审文档；本仓库保留随版本维护的 README、贡献指南和 `docs/`。独立克隆时不依赖上层目录文档才能开发或运行。
- 先读 [README.md](README.md)、[CONTRIBUTING.md](CONTRIBUTING.md) 和相关目录的 `AGENTS.md`；数据流参考 [docs/LEARNING_FLOW.md](docs/LEARNING_FLOW.md)，发布参考 [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md)。
- 旧 Python 版 Sprint、FastAPI/REST 契约及 `courses/<name>/` 布局是历史资料，不直接移植为当前要求。当前行为以源码、配置及对应版本文档为准。
- 对任务目标、范围和结果的把握达到 95% 以上才执行；不明确时先只读检查并澄清，不自行选择会显著影响结果的默认方案。
- 新想法/新功能先调研 GitHub 同类项目（优先专用工具，无工具时用 `gh`），分析架构、依赖、维护情况及可复用设计，提出选型、架构、MVP 与顺序；用户确认后实现。无合适参考时说明结果并商议自行设计。
- 仅在用户或适用规则明确要求时使用子代理；代码审查默认只读，测试代理不修改源码。

## 目录与架构

| 路径 | 职责 |
| --- | --- |
| `apps/cli/` | CLI、本地 `node:http` Host、RPC/SSE 门面、鉴权及静态托管 |
| `apps/web/` | Next.js 16 / React 19 控制台；开发时代理 Host，构建时静态导出 |
| `apps/desktop/` | Electron 主进程、Host sidecar 生命周期和桌面打包 |
| `packages/host/` | API 校验、聊天/课程编排、本地目录选择 |
| `packages/{course,learning,session,agent,tools,acp}/` | 摄取构建、评测/SM-2、会话、Agent Runtime、工具与 ACP |
| `packages/{storage,settings,credentials,workspace,llm}/` | 存储、设置、加密凭据、工作区注册和模型适配 |
| `packages/util/fs-atomic` | 原子替换的 `renameWithRetry`（Windows 临时占用退避重试）；**所有** write-temp + rename 都必须走它，裸 `rename()` 在 Windows 上会间歇性 EPERM |
| `vendor/` | Cordis 等源码内置依赖；遵守 [vendor/AGENTS.md](vendor/AGENTS.md) |
| `scripts/`、`.github/workflows/` | 构建、发布验证与 CI |

- 领域包通过明确导出边界协作，不直接依赖 HTTP 传输层；RPC 输入在 `packages/host/apiproxy/` 用 Zod 校验。
- 学习数据使用普通文件，不引入数据库服务；文件格式、事件或 RPC 变更同步文档及必要的契约/行为测试。
- 区分 Host 全局目录（默认 `~/.studyclaw`，可用 `STUDYCLAW_HOME` 覆盖）和用户课程目录的 `.studyclaw/`，核对配置/凭据实际解析路径，不混同两者。
- 保持 token 鉴权、loopback 边界、路径守卫、审批与凭据加密；不把密钥、token、用户资料或构建产物提交到 Git。
- 不随意修改 `vendor/*/src/`；确有必要时按 vendor 规则记录上游差异。

## 开发与验证

命令均在本仓库根执行。Node.js 要求 `^22.19.0 || >=24.0.0`，包管理器为 `pnpm@11.7.0`，使用现有 `pnpm-lock.yaml`。

```powershell
pnpm install
pnpm build:web             # apps/web/out 静态产物
pnpm serve --open          # 本地 Host，默认 127.0.0.1:8080
```

前端热更新先启动 Host，再在另一终端运行 `pnpm --filter web dev`（默认 3000）；配置见 `apps/web/next.config.ts`，静态构建由同一 Host 托管。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | project references + Web 类型生成与类型检查 |
| `pnpm test` | 根 Vitest 配置中的 Node 和 Web 两个测试项目 |
| `pnpm --filter web lint` | 前端 ESLint |
| `pnpm build` | TypeScript 包构建与包元数据同步 |
| `pnpm build:web` | Next.js 静态导出 |
| `pnpm release:pack` / `pnpm release:verify` / `pnpm release:publint` | 发布打包、真实安装验证、包规范检查 |

按改动运行适当检查；纯文档修改检查链接、路径、命令与 diff，不必运行全量应用测试。结果须区分本次运行与历史记录，不将未运行检查写成通过。

桌面构建见 [apps/desktop/README.md](apps/desktop/README.md)。不提交 `apps/web/out`、包构建目录、桌面资源闭包或安装包。

## Git 与文档

- 从本仓库执行 Git；修改前检查工作树，保留已有未提交改动。
- 提交信息用英文，格式 `emoji type: description`，例如 `📝 docs: clarify maintained project layout`。类型和 emoji 使用贡献指南现有约定。
- 新变更同步相关仓库文档；项目推动和构建决策同步工作区文档（存在该工作区时）。
- 历史文档的测试数量、机器路径、发布状态与计划不是本次验证依据；必要时重新核对。
