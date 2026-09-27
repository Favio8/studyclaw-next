# StudyClaw 发布 Runbook（v0.1.0-beta 及以后）

> 本文把「CI 已验证、需要人按开关」的发布动作固化为可复现步骤。
> CI 侧（ci.yml / desktop.yml / release.yml）已全绿；本文只覆盖**本地手动**部分。

## 0. 前置检查（每次发布前）

```bash
# 以下命令都在仓库根目录（clone 下来的 studyclaw-next/）执行
git status --porcelain          # 必须为空
git log --oneline -3            # 确认 HEAD 是待发布提交
node_modules/.bin/tsc.cmd -b tsconfig.json   # 0 错误
node_modules/.bin/vitest.cmd run             # 全绿（apps/web 单独一份）
cd apps/web && node_modules/.bin/vitest.cmd run
```

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
