# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

开源前的完整代码审查修复轮（高/中/低优先级 22 项全部闭环，
配套对抗性验证与发布门禁全绿）。

### 修复

- 子 Agent（`spawn_agent`）运行时必失败：`TutorSession.init` 改为事件日志优先，
  运行时不透明会话 id（`<parent>-child-<ts>`）不再被 legacy 文件名正则拒绝；
  子会话 id 追加随机后缀消除同毫秒碰撞；
- 事件日志 append 的 O(n²) 性能墙：按路径缓存上次写入后的 stat + 行数，
  健康路径跳过全文件重读重解析（外部写入自动使缓存失效）；
- 学习热力图对新事件日志格式恒计 0 聊天轮：`user/input` 计入、
  `input/voided` 剔除；日详情补 `sync/applied` 变更日志；
- 系统提示词掌握度恒 0%：context 组装复用 tools 的转义感知表格解析器
  （emoji 掌握度单元格 / 含换行备注行 / passRate 三处旧错一次性修复）；
- 聊天同步更新掌握度后 progress.md 表头汇总（总体掌握度 / 待复习卡片数 /
  更新时间）不重算的问题；单元格对齐 `renderMastery` 的 emoji 口径；
- 评测 sm2 帧的 `masteryDelta` 从硬编码 ±0.1 改为指数平滑的真实差值（圆整 3 位）；
- `eval.submit` 宿主接线丢失 `evalId` 参数导致磁盘幂等账本永不写入的问题；
- `regenerateSyllabus` 无变更时报告假版本号 1.0.0；
- `studyclaw session migrate` 使用错误的 history 目录（漏 `.studyclaw` 段）；
- 队列回合错误路径与回答流的 done 帧 `turnId` 字段错填。

### 并发与一致性

- `JobManager` 提升为进程级单例：UI 同步与 Agent 工具触发的同课程构建
  真正共享去重（此前每 turn 新建实例互相失明，可能双跑构建双倍计费）；
- 课程构建改为「先生成后删旧卡」：LLM 生成失败不再削空题池；
  无 LLM 写段套课程文件锁，慢调用留在锁外；
- 设置写入（saveProvider / deleteProvider / activateProvider / updateSettings /
  setCredential）全部纳入 config 写锁（固定 config → credential 锁序），
  并发保存不再互相丢字段；
- 评测幂等账本持久化到 `.studyclaw/eval-ledger/`：宿主重启后同 evalId
  重试重放已结算帧，不再二次计分（TTL 10 分钟，500 文件上限）；
- 工具超时后的孤儿 promise 兜底，迟到的 reject 不再可能打崩宿主进程；
- 模型目录探测加 5 分钟 TTL 缓存（设置页「从端点获取」仍实时）；
- 上传/导入重名落盘改为 `wx` 独占预留，消除 readdir→rename 的并发互覆窗口。

### 内部

- 移除从未被宿主实现的 `Last-Event-ID` 重连残留（幂等由 `requestId` 承担）；
- 掌握度解密失败降级时留告警日志；usage token 数标注为 length/4 粗估口径；
- 清理死代码（`iterSourceFiles` 空 excluded 集、`seedProgress` 覆盖行等）。

## [0.1.0-beta] - 2026-09-04

首个公开测试版。核心形态：本地优先的 AI 学习搭子——挂载一个本地资料文件夹，
构建课程，对话学习、测验复习，状态全部落在本机文件里。

### 学习闭环

- 多格式资料摄取（PDF / Word / Excel / 网页 / Markdown / 源码），SHA-256 增量识别，改哪补哪不重复构建；
- 双层大纲（fine/coarse）+ 依赖推断 + 结构化出题（选择/填空/简答/代码）与质量守卫、难度轮换；
- 四种教学模式：苏格拉底 / 极速冲刺 / 费曼 / 实战 Debug，同一课程状态随时切换；
- 双轨评测：主观题 Rubric 采分点批改（评测走专用快路由省 token），选择题答案键本地零 LLM 秒判；
- SM-2 间隔重复调度（EF 钳制 1.3~2.9、经典间隔序列）、误区变体卡、掌握度热力图、大纲图 / 思维导图双视图；
- 交互演示块（`sc-interactive`）：AI 可在讲解中插入自包含可交互 HTML 演示，运行在断网沙箱 iframe（CSP）内；
  历史回放自动把旧演示块替换为占位行，避免部分自托管网关的确定性断连。

### Agent Runtime

- 23 个工具（13 学习 + 10 通用）与工具审批队列：写操作 / 命令执行需审批，通道缺失时 fail-closed 降级；
- 持久化 Agent 循环：durable inbox（排队/插队/转向/注入）、turn/step 状态机、子 Agent、空闲维护任务；
- ACP（NDJSON）协议模式，可接入兼容的 Agent 客户端；
- CLI 全套命令：`serve` / `status` / `course` / `sync` / `quiz` / `review` / `chat` / `session migrate` / `agent` / `approvals` / `plan` / `todo` / `acp`。

### 桌面版

- Electron 44 桌面壳：单实例、sidecar 内嵌 Host（`ELECTRON_RUN_AS_NODE`，零业务改造）、崩溃退避重启、外链系统浏览器打开；
- 免装 Node：安装包内嵌完整 host 运行时闭包（含平台原生二进制）与 Web UI 静态资源；
- 三平台安装包（Windows NSIS / macOS dmg / Linux AppImage+deb），GitHub Actions 矩阵出包；
- 自动更新元数据（latest*.yml）随 Release 发布（签名/公证待后续版本）。

### 模型接入

- DeepSeek SSE 适配器：思考块与用量解析、传输层错误包装；
- 自托管 OpenAI 兼容网关兼容性：容忍显式 null 的 chunk id/name、非官方端点自动以 `reasoning_effort: "none"` 关闭推理、
  复用池中已被服务端关闭的连接时自动重试；
- 任意 OpenAI 兼容端点可配置（vLLM / SGLang / Ollama / OpenRouter / 各类网关），支持「发现模型」；供应商显示名可选。

### 界面

- Next.js 16 纯静态导出的三栏控制台：左栏导航、中栏对话、右栏进度/大纲/热力/题卡；
- 吉祥物 Clawzy：睡眠/唤醒/搜索/工作/上传/提问/鼓励/进度等状态，quiz 通过庆祝、动态 favicon；
- 消息操作微交互（复制反馈、转复习卡、分支对话），首启向导与项目向导。

### 安全与隐私

- 零遥测、零分析 SDK、零自动更新上报；仅对话/评测请求与你主动调用的搜索工具出站；
- API Key AES-256-GCM 加密落盘（主密钥分离、0600 权限、原子写入、旧明文自动迁移）；
- 本地 Host 仅绑定 `127.0.0.1`：随机启动 token、恒定时间比对、loopback Origin 白名单、413 干净响应；
- 关闭 drive-by RPC 与 SSRF 通道；文件操作拒绝 symlink 越界；课程文件锁保护并发写入。

### 修复

- SSE 流式回合失败（如网关断连）且零输出时，用户输入自动从会话中剔除（补偿事件 `input/voided`）——
  失败后重发不再在会话里留下重复的用户消息；
- 旧行 assistant 输出随失败回合一并 void（`assistant/voided`），恢复会话不再出现孤儿回复；
- 队列回合消费与 ask 幂等重放两条 SSE 路径统一走 `agentEventToFrame` 帧映射——已取消回合不再被
  `done` 帧错误闭环为成功（半截回复当成功渲染）；
- 自托管网关兼容：容忍线格式显式 null 的 chunk id/name；非官方端点以 `reasoning_effort: "none"` 关闭推理；
  自动重试复用池中被服务端关闭的连接；
- CLI 先建会话再发消息的路径补写 `session/create` 事件，不再报「会话不存在」。

### 工程与发布

- TypeScript 全严格类型，pnpm monorepo（25 个内部包 + vendored cordis 生态）；
- 1000+ 测试用例（单元 / jsdom 组件 / HTTP·SSE 集成），`pnpm test` 一条命令全仓覆盖，默认超时内置 60s；
- CI 四道门禁：类型检查（含 tsc 误发射守卫）、双端测试、Web 静态导出、发布链路「打包 → 真装 → 真跑」；
- CLI 以 tsdown 单文件 Bundle 发布（仅 koffi / pdf-parse 两个运行时外部依赖），publint 规范检查；
- 供应链：vendored xlsx 0.20.3 官方 tgz 封堵 CVE-2023-30533 / CVE-2024-22363，离线可复现；
- Node 引擎要求 `^22.19.0 || >=24`（Node 20 已 EOL，不再支持）。

[0.1.0-beta]: https://github.com/Favio8/studyclaw-next/releases/tag/v0.1.0-beta
