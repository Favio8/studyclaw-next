# @studyclaw/desktop — StudyClaw 桌面壳

Electron 桌面壳：把现有「本地 HTTP Host + 静态 Web UI」原样装进桌面应用，
用户**免装 Node.js**。本目录属于当前维护的 `studyclaw-next`，开发约定见
[仓库 AGENTS.md](../../AGENTS.md)，发布流程见 [RELEASE_RUNBOOK.md](../../docs/RELEASE_RUNBOOK.md)。
完整工作区的上层目录用于构建方案与过程文档；此前引用的
`DESKTOP_SHELL_PLAN_studyclaw-next.md` 不在当前工作区中，现以本说明、打包配置与脚本为操作依据。

## 运行结构

```
Electron 主进程 (src/main.cjs)
 ├─ spawn sidecar：ELECTRON_RUN_AS_NODE=1 electron.exe resources/host/bin.js serve --port 0
 │    注入 STUDYCLAW_HOME=<userData>/host-home、STUDYCLAW_WEB_DIST=resources/web
 ├─ 轮询 <userData>/host-home/host.json 拿随机端口
 └─ BrowserWindow → http://127.0.0.1:<port>/（index.html 由静态托管 tap 注入 token）
```

- Host 业务代码零改造；壳只有生命周期胶水（单实例、崩溃退避重启、外链走系统浏览器）。
- 旧 sidecar 的退出回调不能清除新进程；启动错误可见并走退出路径，握手只认可当前子进程的 PID。帮助菜单的数据/日志目录指向实际 `host-home`。
- 应用内导航按当前 Host origin 校验；外链只把 http/https 交给系统浏览器，file 与其他协议不外开。开发 URL 同样按 origin 比较。
- 数据落在各平台规范目录（Windows `%APPDATA%`）的 `host-home/` 下；课程数据仍在用户项目文件夹。
- Windows 系统目录选择器在独立 `resources/host/worker.cjs` 中运行，使用 Koffi 的 UTF-16 字符串解码兼容 Electron；通信只在最终结果发送完后断开。选择器启动失败时，前端自动切到目录浏览；Host 日志保留底层异常。
- 再次运行启动 exe 会显示并聚焦已有窗口；最小化时先恢复，隐藏时也能显示。自动化测试隐藏窗口后必须验证再次启动可恢复，不能仅以 Host health 作为窗口可见的证据。

## 常用命令

从 `studyclaw-next/` 根目录安装依赖，再进入桌面目录运行以下脚本：

```powershell
pnpm install                                   # 安装 electron / electron-builder
cd apps/desktop
pnpm --filter @studyclaw/desktop check:runtime # 校验 Electron 内嵌 Node ≥ 22.19（硬门槛）
node scripts/assemble-host.mjs --build         # 组装 sidecar 资源（可先重建 CLI bundle + web 导出）
node scripts/assemble-host.mjs                 # 只组装（要求 apps/cli/lib/bin.js 与 apps/web/out 已存在）
node scripts/smoke-sidecar.mjs                 # 阶段二冒烟：免装 Node 链路 + token 注入 + 二次启动自愈
node scripts/smoke-desktop.mjs                 # 阶段三冒烟：真实 electron . 整机验证
pnpm --filter @studyclaw/desktop dev:desktop   # 开发壳（需组装过资源）
$env:STUDYCLAW_DESKTOP_DEV_URL='http://127.0.0.1:8080'; electron .   # 联调外部 serve（不拉 sidecar）
node node_modules/electron-builder/cli.js --win --publish never       # Windows NSIS 安装包 → dist/
```

## 本机（Windows + pnpm 不在 PATH）注意

- 一律用 `node node_modules/electron-builder/cli.js …` 直调，不要依赖 `.bin` shim 或全局 pnpm。
- `host-runtime/` 闭包用 `npm install --ignore-scripts` 安装：koffi / @napi-rs/canvas 的
  `*.node` 由平台分包 prebuild 随包分发，postinstall 全是冗余校验。
- extraResources 无法携带 `resources/host/node_modules`——app-builder-lib 的
  `createFilter` 对顶层 `node_modules` 目录硬编码剪枝（`filter.js` "filter the root
  node_modules"）。闭包由 **`scripts/after-pack.cjs`（afterPack 钩子）** 在打包后直接
  `fs.cpSync` 落盘并硬校验 `*.node`。
- 打包态资源根是 `process.resourcesPath`（本身已是 `.../resources`）；开发态是
  `apps/desktop/resources`。`src/main.cjs` 的 `paths()` 已统一这两种布局。

## 产物

组装前检查 CLI bundle 不含需要额外 JS 分块的本地依赖，并检查独立目录选择器入口 `worker.cjs`，失败不会先清空既有资源目录。sidecar 冒烟使用独立临时 home，Windows 上实际选择中文目录、打开项目并取消下一次选择；退出码通过 `process.exitCode` 设置，以便完成临时目录清理。

- `dist/StudyClaw-<version>-setup.exe`：默认 NSIS 安装包（per-user，免装 Node）；若指定输出覆盖参数，以该参数为准。
- 未签名包：首次运行需在 SmartScreen 选「仍要运行」；签名/公证按 `electron-builder.yml` 及发布工作流配置核对。
- `latest.yml` + `.blockmap`：electron-updater 增量更新元数据（发布时与安装包同传 Release）。
