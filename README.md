# StudyClaw（TS 版）

评测驱动、项目即课程、文件即状态的学习 Agent 框架——TypeScript 全栈 monorepo，
架构对齐 [deepseek-harness (dsh)](../../deepseek-ai/deepseek-harness)：cordis 插件
体系 + zod + storage-domain 存储层。旧 Python 实现已冻结（2026-08-24），仅存于
`../studyclaw` 作历史归档，不再作为开发基准。

## 布局

```
apps/                          应用层（cli / web 前端 / desktop 壳）
packages/                     领域包，按 <group>/<pkg> 组织：
  storage/                    storage / storage-domain / storage-json / storage-sqlite
  workspace/ session/ tools/  工作区 / 会话 / 工具规格
  course/                     builder（大纲+增量构建+出题）/ summary
  learning/                   进度/SM-2/Rubric 评测/热力图
  agent/ acp/                 通用 Agent runtime / ACP 协议
  host/                       apiproxy（RPC 边界）/ chat-service（设置/课程/会话服务）
  llm/ settings/ credentials/ attachment/ identity/ util/ runtime-diagnostics/
vendor/                        dsh vendor 的 cordis 生态（MIT，保留原名）
```

## 开发

> ⚠️ 本机 `corepack pnpm` 路径解析已坏（把 `C:\` 错拼成 `D:\c\` 报
> MODULE_NOT_FOUND），统一用仓库根 `node_modules/.bin/<tool>` 直接调；
> `pnpm install` 仍可用。详细坑与约定见 `HANDOFF.md` 与 `AGENTS.md`。

```bash
pnpm install                                                  # 或 corepack pnpm install
node_modules/.bin/tsc -b tsconfig.json                        # typecheck（project references 全图）
node_modules/.bin/vitest run                                  # 后端测试（tsx 源码直跑，无需先构建）
cd apps/web && node_modules/.bin/vitest run                   # web 测试
node_modules/.bin/tsx --tsconfig tsconfig.base.json scripts/smoke-storage.ts   # storage 冒烟
node_modules/.bin/tsx --tsconfig tsconfig.base.json apps/cli/src/bin.ts serve  # 启动 host :8080
```

运行时要求 Node ^22.19 || >=24（storage-sqlite 用内置 `node:sqlite`）。

## 从 dsh 复用的资产

见 `THIRD_PARTY_NOTICES.md`。复制的包保留 `@deepseek-ai/*` 原名以零改动复用；
本项目自有包使用 `@studyclaw/*` 作用域。llm 四件套计划在 M2 连同其依赖闭包
（settings/credentials/attachment/…）一并迁入。
