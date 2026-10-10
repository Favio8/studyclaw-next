# StudyClaw 学习流程总览（studyclaw-next）

> 适用版本：`studyclaw-next` monorepo（唯一活跃主线）。旧 Python 实现已于 2026-08-24 冻结，不再维护。
> 本文同时是端到端验收清单：每一步都标注了涉及代码与落盘文件，出问题时可逐段排查。
> 维护入口：[仓库 AGENTS.md](../AGENTS.md)、[README.md](../README.md)。完整工作区的上层目录存放构建/规划/交接文档；上层旧版规范只作历史参考。

## 0. 进程与端口

| 进程 | 端口 | 启动方式 | 说明 |
|---|---|---|---|
| Host（真后端） | 127.0.0.1:8080 | 仓库根 `pnpm serve`（`apps/cli/src/bin.ts serve`） | 所有业务 RPC/SSE，改后端代码后必须重启 |
| Web 开发服务器 | 3000 | 仓库根 `pnpm --filter web dev` | 开发时 `/api/*` 代理至 Host（`apps/web/next.config.ts`），可用 `STUDYCLAW_API_URL` 覆盖目标 |

生产运行先在仓库根执行 `pnpm build:web`，再 `pnpm serve --open`，由 Host 同源托管 `apps/web/out` 和 API。Electron 桌面版打包同一套静态 Web 与 Host sidecar，默认随机端口；见 [桌面 README](../apps/desktop/README.md)。

LLM 配置：每个课程目录的 `.studyclaw/config.yaml`，模型由用户配置；API Key 优先从配置指定的环境变量解析，其次读取课程目录加密的 `.studyclaw/credentials.json`。不要把 Host 全局目录与课程状态目录混同。

## 1. 「项目即课程」：导入阶段

任何一个本地文件夹被打开为一个 workspace，该文件夹本身就是一门课（courseId = 文件夹名）。

- 入口：左栏「添加项目」（`NewProjectWizard`）选择目录 → RPC `workspaces.open`。
- 注册表存全局宿主侧：`C:\Users\<user>\.studyclaw\workspace.json`（只记路径指针，不动文件夹本身）。
- 首次打开若没有课程骨架会自动建空 `syllabus.json`（无 LLM 参与）。

工作区数据布局（v2，全部收在 `<root>\.studyclaw\`）：

```
harness_learning/
├── harness讲义.pdf            ← 你的原始资料（就地只读）
└── .studyclaw/
    ├── config.yaml            ← LLM provider/model + 解析引擎/阅读模型设置
    ├── credentials.json       ← 加密 API Key 兜底（不进 Git）
    ├── syllabus.json          ← 大纲（章节×概念+依赖图）
    ├── progress.md            ← 进度看板（9 列表格，掌握度/SM-2 排程）
    ├── notes.md               ← 学习笔记（聊天工具 write_note / 阅读标注追加）
    ├── annotations.json       ← 阅读标注与每份资料的阅读进度
    ├── parsed/                ← 可选解析产物（MinerU），含 manifest.json
    ├── .checksums             ← 资料指纹表（增量构建用）
    ├── .layout-v2             ← 布局迁移标记（存在即已迁入 .studyclaw/）
    ├── tasks/task_NNNN.json   ← 题卡池
    └── history/session_*.events.jsonl ← 会话事件流（含热力图数据源）
```

> `sources/` 是**资料**而非状态：项目根即课程扫描根，upload 也落根 `sources/`。
> 布局迁移（`.layout-v2`）只搬状态文件，不搬 `sources/`——否则构建与阅读从此
> 看不见资料。旧版误把它搬进 `.studyclaw/sources/` 的，builder 启动时自愈搬回根。

## 2. 构建：生成大纲与题卡

触发：聊天框 `/build` 或 `/sync`、资料上传、URL 收录。实现链：`courses.sync` RPC → JobManager 异步任务 → `CourseBuilder.build`（`packages/course/builder/src/builder.ts`）：

1. **摄取切片**：PDF 经 markitdown-ts（pdf-parse 纯文本抽取）转 Markdown（`extract.ts`），预处理做结构修复——中文序号行升 H1 章节、原有标题整体降一级、CJK 部首码点还原为真汉字（官方 214 部首序列对齐表 + 词组级 CMap 定向修复，`ingestor.ts`）；`#`=章节、子标题=概念，按段落切块。
   - ⚠️ PDF 拍平后正文里不存在可信的 markdown 标题语义：代码演示中的 shell 注释行（如 `# Response`）会变成裸标题。摄取层按「全文中文密度达标 ＋ 小节纯 ASCII 标题 ＋ 正文零中文」三条件识别这类标签小节并**并入上一节**（不丢内容、不产生垃圾概念）；纯英文文档因全文门槛不触发，结构不受影响。
2. **质量守卫**：`quality-guard.ts` 净化名称并上报异常（不阻塞构建）。
3. **大纲合并**：`mergeSyllabus` 按章节/概念 id 合并；带 `source_file` 来源标记且资料已删除的章节会清理，进度播种随后清理孤儿行。旧版无来源标记的章节保守保留，并在 `report.degraded` 提示全量重建补齐归属。
4. **LLM 出题**：每概念 chunk 结构化调用生成 2~4 条二元 rubric 题卡 → 写 `tasks/task_NNNN.json`。
5. **依赖推断**：全书一次 LLM 调用产出概念 prerequisites。
6. **进度播种**：以大纲为唯一事实源给每概念插一行 0% 记录进 `progress.md`，并清理孤儿行。

构建完成后前端自动刷新右栏各 Tab（`refreshPanelData`）。

## 3. 学习会话：AI 对话

- 新建对话 → 创建 sessionId 与事件流文件；四种模式（苏格拉底/极速/费曼/实战）影响 system 提示词。
- Prompt 组装（`packages/session/session/src/context.ts`）：system = 导师人设 + 模式指令 + 记忆 + 课程状态（章节×概念×掌握度）+ 聚焦概念的原文切片；user = 进度摘要 + 学生消息。
- 流式回复三分流：`<think>`→思考折叠、正文→消息卡、隐藏 `[STUDYCLAW_SYNC]{json}`→**掌握度回写**。
- AI 判断你理解了某概念时通过 sync 块更新该概念掌握度 → 改写 `progress.md` → 前端收到 `sync` 帧立即刷新右栏四 Tab 并点亮角标。

## 4. 测验评测：rubric 打分 + SM-2 复习

- `/quiz` 取题 → 作答 → `eval.submit` SSE 返回扫描、结果、SM-2 和结束事件；LLM 判分路径额外返回逐条 `rubric` 事件，本地答案键路径不伪造 rubric 事件。
- 判定：主观题由 LLM 按 rubric 逐条 Hit/Miss，score=命中比例，passed=score ≥ 0.6；有合法答案键的选择题本地判定，score 为 0 或 1，无需模型调用。
- 掌握度按既有值与本次 score 做指数平滑（无记录时取 score）；按 SM-2 算下次复习日期写回 `progress.md`，并追加 `eval` 审计事件用于热力图。
- 章节状态阈值：≥70% 已掌握 / ≥40% 待巩固 / 其余学习中；左栏 Due 徽标 = 到期待复习数。

## 5. 辅助阅读：资料精读、划词与标注

中栏一级学习活动「阅读」是独立视图（`ReaderView`，路由级 dynamic 加载，pdfjs 不进首屏）。三区：资料树 `MaterialTree` | 阅读区 | 标注栏 `AnnotationRail`。

### 5.1 视图分流

打开资料走 `reading.load`，按扩展名与内容决定视图：

| 条件 | 视图 | 实现 |
|---|---|---|
| `.pdf` 且**首页有文本层** | pdf.js 单页渲染 + 划词 | `PdfCanvas` |
| `.pdf` 且首页零文本项（扫描件） | 解析视图 | `onScanned` 回调切 `ParsedView` |
| `.md` / `.txt` | Markdown 渲染 | `MarkdownReader`（RPC `reading.text`） |
| 其他（docx/xlsx/html…） | 解析视图 | `ParsedView`（RPC `reading.parsed`） |

扫描件只对**首页**判定：混合型 PDF（前几页有文本、中间夹扫描页）不会因翻页在整个视图间反复横跳。

### 5.2 PDF 渲染契约（改 PdfCanvas 前必读）

- **文本层必须挂 `.textLayer` 类**：`globals.css` 引入了 `pdfjs-dist/web/pdf_viewer.css`，`.textLayer` 的 absolute 定位、span 网格与选中样式全靠这个类命中；pdf.js 6 不会自动加。
- **`--total-scale-factor` 必须随 viewport.scale 设置**：文本层 span 的字号/定位按它换算，缺失会让文本层以原始尺寸叠在缩放后的画布上（大小字重叠、选区与视线错位）。
- **缩放自适应**：以 scale=1 测容器可用宽，缩到放得下为止，上限 1.3（小页不放大）；`ResizeObserver` 跟踪滚动容器宽度，≥16px 变化才重渲染。
- **高亮覆盖层必须 `pointer-events-none`**：它叠在文本层之上，一旦吃指针事件，已划过的原文就再也选不中（划词浮层不出现，无法二次标注）。定位跳转由标注栏承担，覆盖层保持纯装饰（`aria-hidden`）。
- **窄容器浮层必须让开工具条**：容器宽 <760px 时标注栏从常驻列退场为浮层（否则三栏全开把阅读区挤到 ~180px）。浮层用 `top-9` 起，**不能 `inset-y-0`**——那会盖住工具条上的「标注」切换钮，打开后无法关闭。

### 5.3 划词与标注

选区经 `mouseup` 捕获（`PdfCanvas.captureSelection`）：归一化 rects（相对页面 0-1）+ quote 双锚（text/prefix/suffix，供版面变化后重定位）。浮层动作：高亮（4 色）、翻译、解释、建卡。

- 标注落库：`reading.highlights.add` → `<课程>/.studyclaw/annotations.json`，单课程单文件、人类可读。概念建议用纯启发式（选区文本与右栏进度概念名包含匹配）随标注落库，不写掌握度。
- `annotations.json` 损坏时备份为 `.bak-<时间戳>` 并空结构重建，响应带 `recovered`，阅读不整体不可用。
- 划词 LLM 动作（解释/翻译）走 SSE `POST /api/reading/explain|translate`，路由 `llm.read_model`（缺省主模型）、思考档位缺省 off，不与判题路径共用配置。
- 建卡（`courses.cardDraft` → `courses.cardCommit`）先出草稿、可编辑题干，确认后才入题卡池。
- 导出：标注 → Markdown（`reading.export`，复制到剪贴板）；`reading.appendNotes` 追加到课程 `notes.md`（带来源标记，进程内串行防丢更新）。

### 5.4 可选解析引擎（MinerU）

`parseEngine`（`auto`/`mineru`/`builtin`）× `parseTier`（`basic`/`standard`/`advanced`）在设置里配置。构建期按文件 sha256 生成内容寻址产物，写 `.studyclaw/parsed/<sha>-<tier>.md` 并逐文件登记 `manifest.json`；`reading.parsed` 按 sha 归因，源文件变了或没构建时给出可读原因而不是空白页。

阅读侧 LLM 可单独配 `readModel` / `readEffort`（null=跟随主模型）。

### 5.5 阅读相关端点

| 通道 | 端点 | 说明 |
|---|---|---|
| RPC | `reading.load` `reading.text` `reading.parsed` `reading.progress.save` | 装载 / md 正文 / 解析产物 / 进度 |
| RPC | `reading.highlights.{list,add,update,remove}` | 标注 CRUD |
| RPC | `reading.export` `reading.appendNotes` `reading.traces` | 导出、追加笔记、按概念聚合的「我的痕迹」 |
| RPC | `courses.cardDraft` `courses.cardCommit` | 划词建卡 |
| GET | `/api/reading.file?source=` | PDF 字节（带 Bearer token，路径守卫 `resolveSourceRef`，只放行 `.pdf`） |
| SSE | `POST /api/reading/explain` `/api/reading/translate` | 划词解释/翻译，帧 `token…/done/error` |

## 6. 右栏四个 Tab 的数据来源（排查指引）

| Tab | 组件 | 后端数据 |
|---|---|---|
| 进度 | ProgressTab | `courses.progress` ← `progress.md`（失败有错误态+重试） |
| 大纲 | SyllabusTab（列表/导图/关系图） | `courses.syllabus` ← `syllabus.json` × mastery join |
| 热力 | HeatmapTab | `metrics.heatmap` ← history/*.jsonl 聚合 |
| 题卡 | QuizTab | `courses.quiz` ← tasks + evalSubmit 六帧 |

已知坑位记录：
- 进度/大纲不同步的历史根因是 PDF 摄取的代码注释伪标题与部首码点错映射（已修：标签小节按上下文吸收 + 214 部首对齐表）；
- 旧数据的来源标记缺失时先查看构建报告并备份，再针对构建产物制定重建方案；不要直接删除整个 `.studyclaw`（其中还有配置、凭据、会话、笔记和学习进度）。改完 builder/host 代码后必须**重启 Host**；Windows 下可用 `netstat -ano | findstr :8080` 核对旧进程是否退出；
- 阅读「划词没反应」先分三种情况：① 页面还没有文本层（扫描件，会自动切解析视图）；② 拖拽落在**已高亮块**上（历史上高亮块是可点 button 且层级更高，已修为 `pointer-events-none`）；③ 拖拽起点落在仍处于选中状态的文字上，浏览器启动原生 HTML5 drag 吞掉 mouseup——先点空白处取消选区即可，这不是缺陷；
- mock 只存在于测试与 `scripts/mock-llm.ts` 开发假 LLM 服务，生产链路零 mock。

## 7. 端到端验收清单

- [ ] 启动 Host 后打开 Web（开发 3000；静态托管默认 8080；桌面端以实际端口为准），选择测试资料目录，左栏出现对应课程
- [ ] 右栏「进度」「大纲」内容一致且干净：无 Response/Chat Completions/Anthropic 等英文标签概念、无字形乱码
- [ ] 发一轮学习对话：流式回复正常，结束后右栏进度角标点亮、掌握度随 sync 更新
- [ ] `/quiz` 主观题显示逐条 rubric 命中、选择题本地答案键判分；两条路径都显示结果及 SM-2 下次复习日期
- [ ] 「热力」出现当日格子
- [ ] 阅读：打开 PDF，画布完整可见且不横向溢出；拖拽窗口后页面按新宽度重排
- [ ] 阅读：划词出现浮层，高亮入库后标注栏计数 +1；**在同一段已高亮原文上再次划词仍能出浮层**（高亮覆盖层不得拦截指针事件）
- [ ] 阅读：翻页后页码与百分比同步，刷新后进度从上次位置恢复
- [ ] 阅读：窄窗口（<760px）下标注栏退场为浮层，**能打开也能再关掉**（浮层不得盖住工具条切换钮）
- [ ] 阅读：`.md` 走 MarkdownReader、扫描件 PDF 与 docx 走解析视图，解析视图有产物或可读的原因

> 阅读的 jsdom 单测只覆盖 DOM 结构、层级与指针事件语义；画布渲染、文本层命中与
> 真实鼠标划词必须用 `apps/web/scripts/e2e-reader.mjs`（真实 Edge + Host 托管
> 静态产物）跑，断言含命中测试与二次划词。
