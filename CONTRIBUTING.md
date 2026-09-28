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
仓库**只用以下五个 emoji**（提交门禁按此校验，多用一个都会被要求重整）：

| emoji | 类型 | emoji | 类型 |
| --- | --- | --- | --- |
| ✨ | feat 新功能 | 🐛 | fix 缺陷修复 |
| 📝 | docs 文档 | ✅ | test 测试 |
| 🏗️ | chore 工程与构建 | | |

- 性能优化归 `🐛 fix`，安全加固归 `🐛 fix`（若只改文档则 `📝 docs`）——不要另用 ⚡ / 🔒 等表外 emoji。
- scope 写领域（`learning` / `host` / `builder` / `web` / `cli` / `desktop` / `ci` / `release` …）。
- 提交前 `git status` 确认暂存文件，别把无关改动捎带进去。

示例：`✨ feat(learning): variant cards for misconception retry`、`🐛 fix(host): guard course mismatch in chat stream`。

## 开发流程

仓库是**单人维护 + 公开协作**的形态，开发轨道与发布轨道完全分离：分支和 PR 永远不会触发发布，
只有打 tag 才会。按改动大小选模式：

| 模式 | 适合 | 说明 |
| --- | --- | --- |
| 直接提 `main` | 文档、错别字、CHANGELOG、一行修复 | 零开销；每次 push 都会跑 CI，坏了当天现形 |
| 分支 + PR | 任何改行为的、周期长的、可能半途而废的、想留审查记录的 | **CI 在合入前就跑**，`main` 不会先进脏东西 |

默认推荐分支 + PR——哪怕只有你一个人，它的价值是「先验货再进门」加一份可回看的改变记录。

### 分支 + PR 完整步骤

```bash
# 1. 从最新的 main 切分支（名字说清干什么：feat/…、fix/…、chore/…）
git switch main && git pull
git switch -c feat/browser-e2e

# 2. 小步提交，每个提交都能独立通过 typecheck（提交规矩见上一节）
git status                    # 提交前必看，确认暂存了该有的文件
git add <具体文件>            # 不要 git add .
git commit -F msg.txt         # emoji + 英文标题 + 中文正文

# 3. 推到远端并开 PR
git push -u origin feat/browser-e2e
gh pr create --fill           # 或 gh pr create --web 在浏览器里写

# 4. CI 自动跑；期间 main 有新提交就并进来（比 rebase 简单，适合单人）
git fetch origin && git merge origin/main

# 5. PR 里自查通过 → GitHub 上 Merge → 回来同步并删分支
git switch main && git pull
git branch -d feat/browser-e2e
```

### 三个工作流机制（建立心智模型用）

| 工作流 | 触发条件 | 作用 |
| --- | --- | --- |
| `ci.yml` | push 到 `main` **和** 所有 PR | 6 个 job：typecheck（含 tsc 误发射守卫）、后端测试、Web 测试、发布链路门禁、Windows + macOS 桌面整机冒烟 |
| `desktop.yml` | PR 触及 `apps/desktop|cli|web`、`packages/**`、锁文件 | 三平台出包矩阵，改桌面壳时提前看打包是否正常 |
| `release.yml` | **仅 tag（`v*`）** | 质量门禁 → 三平台安装包 → npm 实发 → GitHub Release |

> 关键性质：**分支与 PR 永远不可能触发发布**，发布是独立动作。

### 发布流程（与开发分开）

```bash
git switch main && git pull
# 1. 改版本号：根 / apps/cli / apps/desktop 三个 package.json（必须一致，release.yml 会校验）
# 2. CHANGELOG 定稿：[Unreleased] → [x.y.z] - 日期，并补该版本的链接行
# 3. 提交、推送，等 ci.yml 全绿（tag 要指向一个本身是绿的提交）
# 4. 打 tag 并推送：
git tag -a v0.1.2-beta -m "StudyClaw v0.1.2-beta — <一句话摘要>"
git push origin v0.1.2-beta
```

发布后自查：`pnpm view @studyclaw/cli dist-tags --registry https://registry.npmjs.org/`
应见到对应版本；`gh release view v0.1.2-beta` 应含三平台安装包与 `latest*.yml`。
回滚手段见 [docs/RELEASE_RUNBOOK.md](./docs/RELEASE_RUNBOOK.md)（npm unpublish 72 小时内 /
deprecate、GitHub Release 删除）。

### 保命规则

- **绝不 `git push --force` 到 `main`**；自己的功能分支上 force 无所谓。
- **tag 推出去即 immutable**：已被下载/引用的 tag 不要移动，要改内容就新切一个版本号。
- 一个 PR 只做一件事；顺手发现的无关问题另开 PR（否则回滚和 review 都痛苦）。
- 改到一半要切换上下文：`git stash`，或先在分支上提一个 WIP 提交（合入前 squash 掉）。
- UI 改动在 PR 里附截图/录屏；涉及领域契约（RPC、文件格式、事件类型）必须同步补测试。

## 提交 PR

1. 从 `main` 拉出功能分支，小步提交，保持每个提交可独立通过 typecheck（完整步骤见上一节）。
2. PR 描述说清动机、方案与影响面，按模板勾选自查清单。
3. 确保 CI 全部 Job 全绿；UI 改动附截图/录屏。
4. 一次 PR 尽量只做一件事；顺手修的无关问题请另开 PR。

## 报 Issue 的技巧

- 使用 Issue 模板：附上操作系统、Node 版本、`studyclaw status` 输出与 `~/.studyclaw/logs/` 相关日志（**先脱敏**）。
- 环境类问题（安装失败、端口占用、模型连不上）先查 README FAQ 与 Discussions 置顶帖。
- 会话相关的 bug 最好附上出问题的会话 JSONL 片段（删掉个人内容后）。
