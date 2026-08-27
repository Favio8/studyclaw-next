# StudyClaw 学习流程总览（studyclaw-next）

> 适用版本：`studyclaw-next` monorepo（唯一活跃主线）。旧 Python 实现在 `../studyclaw/`，已于 2026-08-24 冻结。
> 本文同时是端到端验收清单：每一步都标注了涉及代码与落盘文件，出问题时可逐段排查。

## 0. 进程与端口

| 进程 | 端口 | 启动方式 | 说明 |
|---|---|---|---|
| Host（真后端） | 127.0.0.1:8080 | 仓库根 `npm run serve`（`apps/cli/src/bin.ts serve`） | 所有业务 RPC/SSE，改后端代码后必须重启 |
| Web 前端 | 3000 | `apps/web` 下 `next dev` | 仅做反向代理：`/api/*` → `http://127.0.0.1:8080`（`apps/web/next.config.ts`），**Next 无自有 API 路由** |

LLM 配置：每个课程目录的 `.studyclaw/config.yaml`（当前为 DeepSeek `deepseek-v4-flash`）；API Key 从环境变量或 `.studyclaw/credentials.json` 解析。

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
    ├── config.yaml            ← LLM provider/model
    ├── credentials.json       ← API Key 兜底
    ├── syllabus.json          ← 大纲（章节×概念+依赖图）
    ├── progress.md            ← 进度看板（9 列表格，掌握度/SM-2 排程）
    ├── notes.md               ← 学习笔记（聊天工具 write_note 写入）
    ├── .checksums             ← 资料指纹表（增量构建用）
    ├── tasks/task_NNNN.json   ← 题卡池
    └── history/session_*.events.jsonl ← 会话事件流（含热力图数据源）
```

## 2. 构建：生成大纲与题卡

触发：聊天框 `/build` 或 `/sync`、资料上传、URL 收录。实现链：`courses.sync` RPC → JobManager 异步任务 → `CourseBuilder.build`（`packages/course/builder/src/builder.ts`）：

1. **摄取切片**：PDF 经 markitdown-ts（pdf-parse 纯文本抽取）转 Markdown（`extract.ts`），预处理做结构修复——中文序号行升 H1 章节、原有标题整体降一级、CJK 部首码点还原为真汉字（官方 214 部首序列对齐表 + 词组级 CMap 定向修复，`ingestor.ts`）；`#`=章节、子标题=概念，按段落切块。
   - ⚠️ PDF 拍平后正文里不存在可信的 markdown 标题语义：代码演示中的 shell 注释行（如 `# Response`）会变成裸标题。摄取层按「全文中文密度达标 ＋ 小节纯 ASCII 标题 ＋ 正文零中文」三条件识别这类标签小节并**并入上一节**（不丢内容、不产生垃圾概念）；纯英文文档因全文门槛不触发，结构不受影响。
2. **质量守卫**：`quality-guard.ts` 净化名称并上报异常（不阻塞构建）。
3. **大纲合并**：`mergeSyllabus` 按章节/概念 id **并集合并（只增不减）** → ⚠️ 手工删除概念或修源码后需要删掉 `.studyclaw` 重建才能生效。
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

- `/quiz` 取到期复习题或新题 → 作答 → SSE 六帧（scan/rubric×N/result/sm2/done，`eval.submit`）。
- 判定：LLM 按 rubric 逐条 Hit/Miss；passed=全命中，score=命中比例。
- 通过则掌握度抬升至 max(旧, score)，未通过压低；按 SM-2 算下次复习日期写回 `progress.md` 并追加 `eval` 审计事件（热力图数据）。
- 章节状态阈值：≥70% 已掌握 / ≥40% 待巩固 / 其余学习中；左栏 Due 徽标 = 到期待复习数。

## 5. 右栏四个 Tab 的数据来源（排查指引）

| Tab | 组件 | 后端数据 |
|---|---|---|
| 进度 | ProgressTab | `courses.progress` ← `progress.md`（失败有错误态+重试） |
| 大纲 | SyllabusTab（列表/导图/关系图） | `courses.syllabus` ← `syllabus.json` × mastery join |
| 热力 | HeatmapTab | `metrics.heatmap` ← history/*.jsonl 聚合 |
| 题卡 | QuizTab | `courses.quiz` ← tasks + evalSubmit 六帧 |

已知坑位记录：
- 进度/大纲不同步的历史根因是 PDF 摄取的代码注释伪标题与部首码点错映射（已修：标签小节按上下文吸收 + 214 部首对齐表）；
- 数据级「脏概念」必须删 `.studyclaw` 重建（合并只增不减）；改完 builder/host 代码后必须**重启 host**（`npm run serve` 前先确认旧进程真的退出：Windows 下杀 npm 外壳不会杀 node 子进程，用 `netstat -ano | findstr :8080` 核对）；
- mock 只存在于测试与 `scripts/mock-llm.ts` 开发假 LLM 服务，生产链路零 mock。

## 6. 端到端验收清单

- [ ] 打开 localhost:3000，左栏出现 harness_learning 课程
- [ ] 右栏「进度」「大纲」内容一致且干净：无 Response/Chat Completions/Anthropic 等英文标签概念、无字形乱码
- [ ] 发一轮学习对话：流式回复正常，结束后右栏进度角标点亮、掌握度随 sync 更新
- [ ] `/quiz` 作答走完六帧：显示逐条 rubric 命中、SM-2 出现下次复习日期
- [ ] 「热力」出现当日格子
