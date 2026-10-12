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

`lint` 要求零错误、零警告（`eslint --max-warnings 0`），CI 的 Web job 在组件测试前运行同一检查。修复 Hook 生命周期、ref 和状态归属问题时保留规则，使用挂载边界、派生状态、提交后 effect 与带清理的订阅处理；不要通过关闭规则或任意延时清除诊断。

生产构建使用 `output: "export"`，产物在 `apps/web/out/`。运行 `pnpm serve --open` 由本地 Host 同源托管静态页面与 API；部署使用该流程。

## 代码入口

- `app/`：页面、布局与主题样式。
- `src/components/`：会话、导航、面板与设置组件。
- `src/lib/api.ts`：Host RPC、SSE 与鉴权调用。
- `src/hooks/`、`src/store/`：交互与状态管理。
- `tests/`：Web 组件和交互测试；仓库根 `pnpm test` 同样包含 Web 测试项目。

功能与领域数据流见 [仓库 README](../../README.md) 和 [学习流程](../../docs/LEARNING_FLOW.md)。


## 阅读与知识提炼

PDF 支持连续滚动，当前页码随滚动更新并保存进度。各页保留真实尺寸，只有视口及相邻页绘制画布/文本层；翻页、原文目录和标注定位滚动到目标页，缩放保留当前阅读位置。

解释/翻译、引用结果、题干与批改反馈、概念定义与目标、导师提问及展开思考使用统一 Markdown 渲染；弹窗/侧栏使用紧凑排版。模型强调边界空格在展示层修正，引用原文和代码保留原样。

右栏顶部的「助手详情」图标点击后打开抽屉，Esc 或关闭按钮退出并停止详情轮询。默认四个 Tab 直接展示学习内容；空计划/空待办不占位。入口用小状态点显示工作、阅读解释/翻译、等待回答或失败状态。

中栏只保留今天、对话、阅读，复习和新题统一在右栏题卡。阅读使用官方 PDF.js 选区交互；「就这段继续对话」在输入框显示原文引用卡，连同文件、页码和翻译/解释进入实际消息。模型名称在进入对话时主动恢复。

「原文目录」在阅读器工具条打开，包含中文释义、原标题和真实页码。学习大纲头部显示主题/概念数；导图可适配全图、打开大图（Esc 返回），导出的 PNG 完整展开所有概念，保留完整标题且不受当前视图平移/缩放影响。

阅读默认适合宽度；工具条支持整页、百分比、+/-、F 专注、Esc 恢复和 Ctrl/Cmd+B 学习面板。缩放作用于文档本身，PDF 标注使用归一化坐标；资料树和标注抽屉按需打开。Word/PPT 使用本地 LibreOffice 预览，图片可缩放拖动，扫描件和图片可主动切换正文 OCR。

上传先建立资料索引。通过「AI 概念提炼」预览、改名、取消选择并确认带原文依据的知识点，再「补齐概念题卡」；现有题卡优先重新归属，保留历史。大纲可展开定义 / 学习目标并点击真实页码引用。

从仓库根运行 `node apps/web/scripts/e2e-reader.mjs` 可验证真实 Host 页面、原生鼠标划词、200% 标注对齐和专注操作。先构建 Web、启动 Host 并选择测试课程；默认使用当前课程的 PDF，`STUDYCLAW_SOURCE` 可指定资料，`STUDYCLAW_BASE` / `STUDYCLAW_EDGE` 可指定服务与浏览器。测试使用页面注入的 token，并清理新增测试标注；截图及报告在忽略的 `verify_tmp/e2e-reader/`。
