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

Host 对所有入口先校验本地 `Host`（localhost / 127.0.0.1 / ::1），再按既有规则检查 Origin 和 token；非本地主机名不能取到带启动 token 的静态页面。静态资源、资料和解析缓存均检查真实路径，链接不能绕过各自的目录边界。

LLM 配置：每个课程目录的 `.studyclaw/config.yaml`，模型由用户配置；API Key 优先从配置指定的环境变量解析，其次读取课程目录加密的 `.studyclaw/credentials.json`。不要把 Host 全局目录与课程状态目录混同。

### 对话工具循环（2026-10-12）

学习对话不再默认限制为 8 轮模型请求：模型没有进一步工具调用、用户停止、提问等待用户或请求失败时结束。保留现有工具超时、模型流空闲超时和取消信号。内部调用者仍可显式设置 `TutorSession.toolLoopLimit`；触顶后会禁用工具并请求最终回答，而不是只输出“已停止工具循环”。一轮可包含多个工具调用，轮数与界面的工具次数不是同一指标。

`read_source` 返回实际展示的 `startLine/endLine`、`nextLine`、`truncated` 和 `partialLine`。每段最多 200 行及 24000 字符，通常按完整行裁剪；正文以编号纯文本回传，使用 32000 字符的资料消息额度，避免再被通用 4000 字符额度截断。单行超长时明确说明只展示开头，不让模型反复读取同一行。先检索定位再读相关章节，证据足够即可回答。

聊天与回答 SSE 监听**响应连接**的提前关闭，将取消传递到 Agent、工具和模型；HTTP POST 请求体读完不等于响应流结束。已产生的消息和工具事件继续保留，停止不会删除历史。

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
    ├── progress.md            ← 进度看板（11 列表格，掌握度/SM-2 排程/阅读接触）
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

已构建资料在摄取失败或未生成有效题卡时保留旧题卡与旧指纹，报告降级并允许下次同步重试；新资料的零题卡生成也不会永久标为完成。首次不可解析资料继续使用原有稳定降级缓存，文件内容或解析配置变化后再按既有规则重判。大纲、指纹和进度的 I/O 读取错误直接报告，不能当空状态重写。

## 3. 学习会话：AI 对话

- 新建对话 → 创建 sessionId 与事件流文件；四种模式（苏格拉底/极速/费曼/实战）影响 system 提示词。
- 自动恢复最近会话只恢复数据，保留当前学习活动；默认仍落在「今天」。主动选择/新建对话才切换到对话活动。
- `read_source` / `search_sources` 的 Host 文档抽取回调复用已有 PDF、DOCX、XLSX、HTML 引擎；文档经原有源路径守卫后转换成正文，搜索结果和读取使用同一份抽取文本的行号。原始文档仍只读。
- Prompt 组装（`packages/session/session/src/context.ts`）：system = 导师人设 + 模式指令 + 记忆 + 课程状态（章节×概念×掌握度）+ 聚焦概念的原文切片；user = 进度摘要 + 学生消息。
- 流式回复三分流：`<think>`→思考折叠、正文→消息卡、隐藏 `[STUDYCLAW_SYNC]{json}`→**掌握度回写**。
- AI 判断你理解了某概念时通过 sync 块更新该概念掌握度 → 改写 `progress.md` → 前端收到 `sync` 帧立即刷新右栏四 Tab 并点亮角标。
- 事件日志读取失败时停止追加；损坏日志必须成功备份到唯一 `.corrupt-*` 文件才允许重建。旧格式会话创建使用独占写，归档和排序的整段读改写共用对应文件锁。

## 4. 测验评测：rubric 打分 + SM-2 复习

- `/quiz` 取题 → 作答 → `eval.submit` SSE 返回扫描、结果、SM-2 和结束事件；LLM 判分路径额外返回逐条 `rubric` 事件，本地答案键路径不伪造 rubric 事件。
- 判定：主观题由 LLM 按 rubric 逐条 Hit/Miss，score=命中比例，passed=score ≥ 0.6；有合法答案键的选择题本地判定，score 为 0 或 1，无需模型调用。
- 掌握度按既有值与本次 score 做指数平滑（无记录时取 score）；按 SM-2 算下次复习日期写回 `progress.md`，并追加 `eval` 审计事件用于热力图。
- 章节状态阈值：≥70% 已掌握 / ≥40% 待巩固 / 其余学习中；左栏 Due 徽标 = 到期待复习数。
- 课程 ID 是文件夹名，不能用于唯一标识项目。面板、会话、题卡及评测的异步写回同时校验项目路径和激活代次；同名项目、A → B → A、切换新卡/复习都不能复用旧请求或落下旧结果。

## 5. 辅助阅读：资料精读、划词与标注

中栏一级学习活动「阅读」是独立视图（`ReaderView`，路由级 dynamic 加载，pdfjs 不进首屏）。三区：资料树 `MaterialTree` | 阅读区 | 标注栏 `AnnotationRail`。

### 5.1 视图分流

打开资料走 `reading.load`，按扩展名与内容决定视图：

| 条件 | 视图 | 实现 |
|---|---|---|
| `.pdf` | 原页预览与数字 PDF 文本层 | `PdfCanvas` |
| `.doc/.docx/.ppt/.pptx` | LibreOffice 本地生成的 PDF 预览，保留原文件 | `PdfCanvas` + `officePreview` |
| `.png/.jpg/.jpeg/.webp` | 原图预览、缩放与拖动 | `ImageCanvas` |
| `.md/.txt` | Markdown 阅读与字号缩放 | `MarkdownReader` |
| `.xlsx/.html/.htm` 或手动选择「正文 / OCR」 | 按页的正文 / 识别文字，可划词 | `ParsedView`（`reading.parsed`） |

扫描件保留原 PDF 预览，不因首页无文本自动替换整个文档。需要文字时点击「正文 / OCR」；图片与扫描件 OCR 使用本地 MinerU。Office 页码依据预览 PDF 提取，引用与可见页面使用相同版面。

### 5.2 PDF 渲染契约（改 PdfCanvas 前必读）

- **连续阅读**：所有页面保留真实尺寸的滚动占位，IntersectionObserver 只绘制视口及相邻页面，离屏时释放画布、文本层和页资源。普通滚轮/触控板使用原生滚动，不再在页尾替换页面；仅 Ctrl/Cmd+滚轮接管缩放。
- **页码来源**：滚动报告用于更新当前页/保存进度，不能当成外部跳页指令；翻页按钮、目录和标注定位才滚动到目标页。缩放/窗口变化按页面内的可见中心恢复位置。
- **模块与监听生命周期**：先初始化 pdfjs-dist，再加载依赖 globalThis.pdfjsLib 的 pdf_viewer.mjs，模块由单文档共享。TextLayerBuilder 的全局选择监听使用文档级 AbortSignal；单页离屏只 cancel 本页文本层，不 abort 其他页面的选择监听。

- **文本层必须挂 `.textLayer` 类**：`globals.css` 引入了 `pdfjs-dist/web/pdf_viewer.css`，`.textLayer` 的 absolute 定位、span 网格与选中样式全靠这个类命中；pdf.js 6 不会自动加。
- **`--total-scale-factor` 必须随 viewport.scale 设置**：文本层 span 的字号/定位按它换算，缺失会让文本层以原始尺寸叠在缩放后的画布上（大小字重叠、选区与视线错位）。
- **独立缩放**：默认适合宽度，可选整页、100% 或 25%–400% 手动比例。`ResizeObserver` 跟踪宽高，按当前模式计算 viewport；画布按设备像素比渲染，文本层与标注始终使用 CSS 页面坐标。重绘取消上一份 render/text task，切源销毁自有 worker；已有页面缩放尽量保持可见中心。
- **高亮覆盖层必须 `pointer-events-none`**：它叠在文本层之上，一旦吃指针事件，已划过的原文就再也选不中（划词浮层不出现，无法二次标注）。定位跳转由标注栏承担，覆盖层保持纯装饰（`aria-hidden`）。
- **阅读空间优先**：进入阅读时右侧学习面板收起、左侧导航变为窄栏，退出阅读恢复外壳布局；资料树和标注抽屉默认关闭。标注抽屉放在工具条下方的内容区域，工具条换行也不会被覆盖。F 临时隐藏周边栏，Esc 恢复；Ctrl/Cmd+B 可切换学习面板。

### 5.3 划词与标注

PDF 使用现有 PDF.js 的 `TextLayerBuilder`，包含官方 `endOfContent` 与全局选区变化处理，限制拖动进入词间空白时的选区跳变；页面离屏/重绘时取消本页任务，切资料时销毁 worker 和文档级监听。选区经 `mouseup` 在实际页面捕获（`PdfPage.captureSelection`）：归一化 rects（相对页面 0-1）+ quote 双锚（text/prefix/suffix，供版面变化后重定位）。浮层动作：高亮（4 色）、翻译、解释、建卡。

「就这段继续对话」把原文、文件、页码和翻译/解释保留为输入框引用卡，按工作区/课程/会话隔离，可展开或移除；发送时完整加入实际消息，沿用原有排队、重试和会话存储，不再截取前 1500 字作为建议入口。

阅读器工具条的「原文目录」从该资料的原始目录和真实页块匹配页码，保留原标题并提供中文释义；同一组标题的翻译在当前应用内缓存。无法定位的条目明确显示「未定位页码」，不生成猜测页码。

- 标注落库：`reading.highlights.add` → `<课程>/.studyclaw/annotations.json`，单课程单文件、人类可读。概念建议用纯启发式（选区文本与右栏进度概念名包含匹配）随标注落库。
- **阅读接触（`exposure`）**：高亮若已关联概念（`conceptId` 非空），在**同一把课程锁内**把 `progress.md` 该概念的 `exposure` 列 +1。这是纯观测维度，**不改变掌握度、不参与 SM-2**——掌握度语义必须保持由 eval 单一驱动。写入失败只记日志，标注照常保存（标注已落盘，不该因统计数字失败而丢失划线）。`conceptId` 为空（常见）不产生曝光。
- 英文选区与概念名称的包含匹配忽略大小写；未命中时仍保持 `conceptId: null`。
- **复习回看原文**：`courses.quiz` 在 **review 模式**下随题回带该概念的 `hints`（最近 2 条划线的原文与出处，取自 `annotations.json`）。新卡模式不下发——首次学习不该先看答案性线索。**`hints` 只进 UI，绝不进评测提示词**：否则用户可照抄原文，评测失真会连带污染掌握度与 SM-2。
- `annotations.json` 的 JSON 语法或内部结构损坏时，先备份为 `.bak-<时间戳>-<唯一标识>`，再落盘空结构，响应带 `recovered`；恢复与标注/进度写入共用课程锁。文件读取或备份失败直接报告错误，不用空数据覆盖原文件。
- 划词 LLM 动作（解释/翻译）走 SSE `POST /api/reading/explain|translate`，路由 `llm.read_model`（缺省主模型）、思考档位缺省 off，不与判题路径共用配置。
- 建卡（`courses.cardDraft` → `courses.cardCommit`）先出草稿、可编辑题干，确认后才入题卡池。
- 导出：标注 → Markdown（`reading.export`，复制到剪贴板，复制失败明确提示）；`reading.appendNotes` 与聊天 `write_note` 共用笔记追加入口及课程锁，v2 课程首次笔记也落在 `.studyclaw/notes.md`；尚未迁移的旧布局继续追加原笔记。笔记路径为符号链接或不可读时拒绝写入。
- 阅读 RPC/SSE 响应只更新发起时的项目、课程和资料打开周期；快速 A → B → A 也不能让首次 A 的响应覆盖新状态。关闭题卡草稿即放弃其在途 UI 更新，旧响应不能重开面板；翻页保存的旧响应不能让当前页码回退。

阅读动作卡与输入框引用结果使用共享 MarkdownView 的 compact/modelOutput 模式，支持流式标题、列表、强调、引用、代码和 GFM 表格。强调边界空格修正只作用于模型展示，跳过围栏/缩进代码及行内代码；保存、复制和引用使用原始内容。该渲染也覆盖题干/批改、概念定义/目标、导师提问、展开思考和非空会话计划/待办。

### 5.4 可选解析引擎（MinerU）

`parseEngine`（`auto`/`mineru`/`builtin`）× `parseTier`（`basic`/`standard`/`advanced`）在设置里配置。内置与 MinerU 产物都按文件 SHA 缓存在 `.studyclaw/parsed/`，manifest 如实记录引擎、档位与输出文件。auto 回落的内置文本可阅读，后续构建仍会重试 MinerU；切回已有档位复用产物。未构建的资料可按需解析，已有 manifest 与源文件不一致时提示更新。结构化缓存 `<sha>-structure-v1.json` 包含真实页码和正文块；MinerU middle JSON 的 OCR 坐标也保留。

manifest 的产物名必须是单个 Markdown 文件名，不能含路径段；读取再次校验真实路径，缓存目录链接也不能越界。`.md/.txt` 阅读最多返回 200,000 个字符，并按该上限有界读取；PDF 文件流遇到磁盘错误只关闭当前响应，客户端断开即释放文件流。

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

四个 Tab 默认直接显示自己的学习内容。运行诊断改为顶部「助手详情」入口的按需抽屉，关闭时卸载 AgentRuntimePanel 并停止其 1.5 秒轮询；小状态点从现有聊天/阅读/排队/提问状态派生，不额外查询。阅读动作单独显示为阅读助手状态，对话运行记录标明「对话助手」。空计划和待办不再渲染占位。固定 128000 估计的上下文百分比改为明确的累计输入/输出 Token。

| Tab | 组件 | 后端数据 |
|---|---|---|
| 进度 | ProgressTab | `courses.progress` ← `progress.md`（失败有错误态+重试） |
| 大纲 | SyllabusTab（列表/导图/关系图） | `courses.syllabus` ← `syllabus.json` × mastery join；概念行尾的概念级证据汇总取自 `courses.digest` |
| 热力 | HeatmapTab | `metrics.heatmap` ← history/*.jsonl 聚合 |
| 题卡 | QuizTab | `courses.quiz` ← tasks + evalSubmit 六帧 |

`courses.digest` 是「今天」视图与大纲汇总**共用**的聚合接口：一次读 `progress.md` + 题池 + `annotations.json`，
按 `concept_id` 归并成概念级摘要（含近 24 小时新划线条数）。前端不按概念逐个请求，避免 N+1。

划线、删除标注和阅读建卡成功后刷新摘要；「今天」的到期数按当前本地日期重新计算，不使用上次写盘的缓存数字。

中栏只显示今天、对话、阅读；新题/复习统一在题卡操作。大纲头部展示主题/概念数，内部版本只在悬停详情；概念依据用 Lucide 线性折叠箭头。导图支持真正适配全图和大图窗口（Esc 退出），工具栏独立于画布；PNG 从独立的完整展开布局导出，以原尺寸 × 2 像素比截取内容节点，完整显示长标题，不继承当前平移/缩放/折叠。

`sessions.models` 新增可选 `currentOnly: boolean`：为 true 时只读取当前会话路由，不探测供应商目录。模型座位挂载时据此恢复名称，新对话/无会话时读取相应会话路由或设置默认值；完整模型目录仍在打开菜单时加载。

课程备份只包含大纲、进度、笔记、标注、题卡和会话历史，保留 `.studyclaw/` 布局；原始资料需另行复制，模型配置与凭据需重新设置。
导入把课程还原到当前项目下的独立目录，并注册为一个新项目，刷新页面后可在左栏打开。上传期间切换项目不会改变本次还原目标。
已有数据的读盘失败或符号链接会使导出报错；备份可保存损坏 JSON 的原始字节，但导入会拒绝结构无效的大纲、题卡或标注。
覆盖导入在最终安装失败时把旧目录恢复到原路径；备份含题卡答案和会话历史，分享前需自行确认内容。

已知坑位记录：
- 进度/大纲不同步的历史根因是 PDF 摄取的代码注释伪标题与部首码点错映射（已修：标签小节按上下文吸收 + 214 部首对齐表）；
- 旧数据的来源标记缺失时先查看构建报告并备份，再针对构建产物制定重建方案；不要直接删除整个 `.studyclaw`（其中还有配置、凭据、会话、笔记和学习进度）。改完 builder/host 代码后必须**重启 Host**；Windows 下可用 `netstat -ano | findstr :8080` 核对旧进程是否退出；
- 阅读「划词没反应」先分三种情况：① 页面还没有文本层（扫描件，主动切换「正文 / OCR」识别文字）；② 拖拽落在**已高亮块**上（历史上高亮块是可点 button 且层级更高，已修为 `pointer-events-none`）；③ 拖拽起点落在仍处于选中状态的文字上，浏览器启动原生 HTML5 drag 吞掉 mouseup——先点空白处取消选区即可，这不是缺陷；
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
- [ ] 阅读：资料列表和标注抽屉默认关闭，任意窗口宽度下都能展开并关闭，且不盖住工具条
- [ ] 阅读：Word/PPT 可翻页和缩放；图片可缩放、拖动并切正文 OCR；Markdown/解析正文的比例控制实际改变字号

> 阅读的 jsdom 单测只覆盖 DOM 结构、层级与指针事件语义；画布渲染、文本层命中与
> 真实鼠标划词必须用 `apps/web/scripts/e2e-reader.mjs`（真实 Edge + Host 托管
> 静态产物）跑，断言含命中测试与二次划词。


## 8. AI 概念与文档目录（2026-10-11）

上传 / 同步先建立资料索引，不在用户确认知识点前批量生成题卡。尚未提炼的结构在进度栏标记为「资料结构（待提炼）」。已有 AI 概念的同步保留大纲与题卡，新增或修改资料通过提炼草稿确认纳入。

「AI 概念提炼」可针对当前资料或课程资料运行：读取真实页块 → 分批提炼候选并核对引用 → 先建立最多 6 个主题分组 → 用分组枚举合并 12–30 个核心概念 → 为已有题卡生成归属方案 → 用户改名 / 取消选择 → 采用。文件名、作者元数据和普通章节标签不作为学习概念；文档目录单独保留。调用复用现有供应商与加密凭据，采用 off 思考档位，候选按来源内容与模型缓存。

新增 RPC：`courses.concepts.draft {courseId,sources}`、`courses.concepts.apply {courseId,draftId,edits:[{id,name}]}`、`courses.concepts.cards {courseId}`。采用前校验大纲 / 题卡与源文件版本；采用操作创建 `.studyclaw/concepts/before-<draftId>.zip`，保留原卡 ID、题干、答案及 history，无法归属或未评测的重复卡标记 deprecated。仅同一稳定概念 ID 延续掌握度，旧汇总保存在迁移记录和备份；标注内容及阅读位置保留，可明确关联的标注重新归属。缺题概念通过「补齐概念题卡」在采用后出题，已有题卡不重生。

Syllabus 可包含 `concept_origin`、`document_outline`；概念新增 `definition`、`learning_objective`、`evidence[{source,page,block_id,quote}]`。原文页码由解析器提供，引文必须匹配指定块；模型不能自行指定页码。大纲中可展开定义 / 目标 / 依据并跳页；引用跳转不增加阅读进度，多次同源跳转以最新打开周期为准。

Office 需本机安装 LibreOffice（`STUDYCLAW_SOFFICE` 可指定 executable）。OCR 需 `uv tool install "mineru>=4.0,<5"`，使用本地 `mineru-kit parse --format middle_json`；Office 派生 PDF 在 `.studyclaw/previews/`，原文件不修改。预览字节复用 `/api/reading.file` 的鉴权与课程路径边界。
