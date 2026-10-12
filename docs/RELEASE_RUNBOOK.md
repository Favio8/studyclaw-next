# StudyClaw 发布 Runbook（v0.1.0-beta 及以后）

> 本文把「CI 已验证、需要人按开关」的发布动作固化为可复现步骤。
> 适用仓库：当前维护的 `studyclaw-next`，旧 Python 版 `studyclaw/` 已废弃。工作区上层存放构建方案与过程文档，本手册随代码版本维护。
> 本文的 CI 通过记录与 `0.1.0-beta` 命令是历史发布示例；实际发布前核对当前工作流结果、待发布版本和产物名称。维护约定见 [AGENTS.md](../AGENTS.md)。

## 0. 前置检查（每次发布前）

```bash
# 以下命令都在仓库根目录（clone 下来的 studyclaw-next/）执行
git status --porcelain          # 必须为空
git log --oneline -3            # 确认 HEAD 是待发布提交
pnpm typecheck                 # project references + Web 类型生成与检查
pnpm test                      # Node + Web 两个测试项目
pnpm --filter web lint         # 零错误、零警告
pnpm release:pack
pnpm release:verify
pnpm release:publint
```

CLI 和桌面侧均交付单文件 Host `bin.js` **及独立目录选择器进程入口 `worker.cjs`**：tsdown 显式关闭 code splitting，打包与组装前用 AST 检查 Host 的本地 import/export/dynamic import，并检查 worker 存在。该 worker 由 `spawn` 启动，不在模块导入图中，不能依靠单文件 AST 检查证明它已打包。npm 产物还须包含 `THIRD_PARTY_NOTICES.md`。

`release:verify` 使用真正安装的 CLI 和 Host，验证 multipart 上传以及 backup 导出 → 导入 → 项目注册 → 打开 → Markdown 再导出的完整往返；不以 CLI 的 RPC 桩测试替代这条发布门禁。

Windows 上 `release:verify` 和桌面 `scripts/smoke-sidecar.mjs` 还会打开真实系统文件夹窗口，选择含中文、空格、单引号及 emoji 的隔离目录，验证 RPC 返回完整路径 → 打开项目 → 读取课程，以及取消返回 null、没有残留窗口。脚本只操作测试 Host 子进程的窗口。Electron 的外部内存限制由真实路径选择覆盖，取消测试不能替代此验收。Windows CI 的 desktop-smoke 已接入此门禁；本机运行通过不代表远端 CI 已运行。

`release:verify` 在隔离 home 中安装 tarball、运行 `--help` / `status`，再启动安装后的真实 Host，打开离线测试课程并执行 multipart 上传；测试 Host 不继承真实模型凭据。不能只用入口可启动作为上传链路可用的证据。这些命令仅构建和验证，不发布。

## 1. npm 发布 @studyclaw/cli

**状态**：CI 的 npm job 已 dry-run 验证（NPM_TOKEN 未配置时自动降级）；本地
`release:pack → verify → publint → publish --dry-run` 全通过。二选一：

### 方式 A：本机发布（快）

```bash
# ① 确认 registry 是 npmjs（本机默认可能指向 npmmirror！）
npm config get registry
npm config set registry https://registry.npmjs.org/

# ② 登录
npm login

# ③ 发布（artifacts/ 下的 tgz 由 release:pack 产出）
cd artifacts
npm publish studyclaw-cli-0.1.0-beta.tgz --tag beta --access public --cache .npm-cache

# ④ 恢复镜像（国内后续安装更快）
npm config set registry https://registry.npmmirror.com/
```

### 方式 B：CI 发布（推荐，环境干净）

仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（Granular
token，仅限 `@studyclaw` scope 的 read/write），然后：

```bash
gh run list --workflow=release.yml --limit 5      # 先取 run id（不是 job id）
gh run rerun <run-id> --failed                    # 只重跑失败的 job
```

release.yml 的实际顺序：`gate`（typecheck + 测试）通过后，**npm 发布与三平台
桌面打包并行**，两者都成功后 `github-release` job 才创建 Release 并上传全部
产物。也就是说 npm 包通常比 GitHub Release 更早可安装——排障时别把"Release
还没出现"当成"npm 没发"。

### 发布后验证

```bash
npm view @studyclaw/cli dist-tags        # 应见 beta: 0.1.0-beta
npm view @studyclaw/cli versions --json | tail -5
```

## 2. GitHub Release（桌面壳 + 便携版）

tag 触发（release.yml 自动完成三平台打包 + 上传）：

```bash
git tag v0.1.0-beta
git push origin v0.1.0-beta
```

手动补资产时（便携版 zip 在 artifacts/）：

```bash
gh release upload v0.1.0-beta artifacts/StudyClaw-0.1.0-portable-win-x64.zip --clobber
```

## 3. 仓库可见性

- studyclaw-next：**已公开**（2026-09-27）
- studyclaw（旧 Python 版）：**已归档**（read-only），README 有重定向声明

## 4. 回滚

- npm：`npm unpublish @studyclaw/cli@0.1.0-beta --force`（72 小时内）或
  `npm deprecate @studyclaw/cli@0.1.0-beta "reason"`
- GitHub Release：`gh release delete v0.1.0-beta --yes`（tag 需另删）

## 5. 已知注意事项

- Windows 本机 `dist/win-unpacked.tmp` 可能被索引器锁死，出包用
  `-c.directories.output=dist5` 绕过（CI fresh runner 无此问题）
- 本机直连 GitHub 超时时，Electron 下载设
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 发布**前**：release.yml 的 npm job 自己会跑一遍 pack → verify（真装一遍并
  运行）→ publint，任一步失败就不会发布；ci.yml 的 release-gate 在每次
  push/PR 也跑同一套门禁，问题更早现形
