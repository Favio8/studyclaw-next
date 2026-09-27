# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

开源前的完整代码审查修复轮（高/中/低优先级 22 项全部闭环，
配套对抗性验证与发布门禁全绿）。

测试覆盖与安全文档收尾（2026-09-27）：

### 测试

- 新增 `apps/cli/tests/serve-http.spec.ts`（9 用例）：serve 主循环此前零集成
  覆盖——现在以子进程起真实 Host 断言 token 门禁顺序（无/错 token 401、
  正确 200）、Origin 403 先于 token、GET /api/* 405、静态托管 tap 注入与
  SPA 回落、三种编码穿越不泄漏、上传路由 409 边界、SIGINT 优雅关停后
  host.json/host.lock 真正删除（C-1 回归）、实例锁强杀自愈；
- smoke-desktop 退出段改走应用自身退出路径（SIGTERM / taskkill 无 /F），
  sidecar 残留纳入 pass 条件（旧实现用外部强杀却声称验证 R6）；并剔除
  调用方环境继承的 ELECTRON_RUN_AS_NODE（会让 electron 退化为纯 Node）。

### 安全

- C-13（静态托管 token 门禁）经威胁模型分析后关闭为文档化取舍：访问
  token 必须明文落盘（host.json）供桌面壳/CLI 发现，门禁对能读磁盘的
  同机攻击者无效，仅防跨站 drive-by（现有同源策略已覆盖）；SECURITY.md
  已精确声明该边界并给出 OS 级缓解建议（独立用户账户、磁盘加密、ACL）。

弹层焦点管理修复（W-10，提交 `ed18fd6` 及接入提交）：

### 修复

- 新增 useFocusTrap hook + 模块级弹层栈：打开聚焦首个控件（或 [data-autofocus]）、
  Tab/Shift+Tab 弹层内首尾循环、Escape 关闭（尊重各弹层 busy 语义）、关闭后
  焦点还原；document capture 阶段监听，嵌套弹层仅栈顶响应（ModelsSection 的
  确认框在设置弹层内）；
- 七个 aria-modal 弹层全部接入：SettingsDialog（删自有焦点/Escape 逻辑，初始
  焦点改首个导航项）、MaterialsDialog（补初始焦点与 Escape）、NewProjectWizard
  （抽 WizardShell 统一各阶段，分支切换不再持有旧容器监听器）、LeftNav 移除
  确认/重命名对话框、ModelsSection 删除/覆盖/模型候选三框；
- 全局快捷键穿透修复：Tab 与 Ctrl 组合键守卫改查 modal 栈——MaterialsDialog
  等本地 state 弹层打开时 Tab 不再切背景三栏焦点、Ctrl+N 不再背后新建会话；
  Ctrl+K 在任意弹层打开时不叠开 Palette（消除半叠加态）。

### 测试

- 新增 focus-trap.test.tsx 5 用例（初始聚焦/边界循环/Shift 反向/Escape/焦点还原/
  嵌套栈顶仲裁）；materials-dialog 增补初始焦点与 Escape 两例。

前端队列状态机与测试缺口修复（提交 `bab236f`/`9c30e83`/`9021984`）：

### 修复

- W-3：队列 drain 旧实现用 setTimeout(0) 延续——setStreaming(false) 与
  drain 之间的 macrotask 边界是双流窗口（用户新消息绕过守卫开第二条流、
  drain 抢占 abort 把新流冻成半截且无错误行、停止键管不到即将 drain 的
  流）；改为同步调用，false→true 同一 macrotask 内完成；
- W-4：命令在流式中入队时旧实现会建服务端 durable 回合，但 drain 时命令
  直接执行、turnId 从未下发——服务端回合永不消费（QueueDock「队列中 N」
  永久卡住，宿主自行消费 inbox 时命令文本又会作为普通 LLM 回合跑一遍）；
  命令（含未知命令）现在只进本地队列，普通消息仍建 durable 回合。

### 测试

- 新建 LeftNav 回归用例 5 个（列表瞬断韧性 / 多课程徽标与切换行 / 搜索
  命中打开失败 / 菜单外点关闭 / 重命名撞名阻断）；
- models-section 增补 409 覆盖 + 存 Key 失败组合用例（N-1）。

左栏项目/课程管理与 API Key 添加专项审查修复（提交 `c2171cc`/`7992f57`/`fdf7716`）：

### 修复

- 左栏跨项目搜索命中打开失败（目录已删/无权限）时无反馈且留 unhandled
  rejection：改为横幅提示并保持搜索打开，成功后再关闭；
- 项目列表加载瞬时失败被整体清空（用户以为项目全丢）：保留上次列表 +
  横幅说明，切换项目时仍会重试；
- 多课程项目在左栏只显示第一个课程、其余课程无入口：激活项目的会话树
  跟随当前激活课程，多课程项目在会话树下方渲染「切换课程」行，非激活
  多课程项目行显示「N 课程」徽标；
- 模型配置保存分两步（saveProvider → setProviderCredential），第二步失败
  时行不显示且用户重试必撞 409 覆盖确认：改为 payload 照刷新、卡片正常
  收起、横幅指明「配置已保存但 Key 保存失败」与补救路径；
- 「从端点获取」可把同一模型重复添加进列表（后端不校验唯一性）：采纳时
  按 id 去重并提示跳过数量；
- 对话操作菜单点击外部不关闭（仅能点其他菜单项）；
- 项目重命名冲突只标红不阻断（明知重名仍发请求）：前置拦截；
- 移除项目后不清课程会话缓存，重新添加同一目录时旧会话短暂复现；
- 设置页「＋ 添加供应商」在目录加载期间无提示地禁用：文案改「加载目录中…」；
- API Key 输入框无显示明文切换：新增 eye 切换按钮；
- 空 provider 列表的添加卡被手动收起后，会因设置页其他页签的保存刷新而
  反复重开：记住用户的收起选择。

发布后第五轮对抗性审查修复·第二批（P0+P1 之外的 Medium/Low 与加固项，
提交 `60fe311`/`f5a532a`/`8fa6cf7`）：

### 修复

- 审批期间 abort 的裸 Error 穿出工具执行层（executeWithRetry 不捕获）→
  结构化 TOOL_CANCELLED；
- write_file 目标为 Windows 保留设备名（CON/NUL/PRN/COM1…）时假成功 →
  显式拒绝；
- evaluate_answer/create_card/generate_dynamic_card 的长文本参数无上限 →
  4000 字符封顶（prompt 成本放大防护）；
- workspacePath 异盘绝对路径 containment 失效（Windows 跨盘逃逸原语）→
  isAbsolute 显式拒绝；LSP file_path 纳入同一 containment；
- learning 包硬编码 `.studyclaw/` → 未迁移旧布局工作区的到期调度与热力图
  静默失效，补 v2/旧布局回退；
- builder 状态文件写无 fsync → write+fsync+rename；源文件无大小上限 →
  64MB 守卫 + degraded 上报；
- 布局迁移半迁移永久化（rename 失败仍写 marker）→ 失败不写 marker 下次重试；
- gitops `git add -A` 把题池（含答案）与 eval-ledger 提交进用户 git 历史 →
  状态目录 .gitignore 排除（已被历史跟踪的文件需用户自行 untrack）；
- 动态卡 task_id 同毫秒跨批碰撞 → 随机后缀；到期选卡按概念去重（公平性，
  不足时同概念补位）；
- SSE 解析器对齐规范：多 data 行 \n 连接、坏帧跳过不炸流、decoder flush、
  孤立 \r、无空格 field 形态；
- refreshCourseList 切工作区守卫缺失 → 旧工作区 courses 不再覆盖新工作区；
- 热力图日回放详情无课程归属 → 切项目即清空；
- 聊天 abort 路径不恢复 syncState（左栏/爪爪永久"同步中"）与陈旧队列残留
  （误导横幅）→ 补齐；流式收尾提交加会话归属；
- 资料上传未配模型时静默不构建 → 显式告知；设置弹层打开时 Ctrl+K 叠开
  Palette → 让位；
- terminal 管道行数无上界 → 1000 行截断+单次告警；/api/acp 路由抛错时
  request 条目残留 → finally 清理；静态托管无缓存/安全头 → no-cache HTML /
  immutable hash 资产 / nosniff；SIGINT 监听器空闲态摘除后不重装 →
  prompt 前幂等重装。

### 内部

- apiproxy 数值参数补范围（temperature 0~2 / maxConcurrency 1~32）；
  catch-all 与 ENOENT 错误脱敏（路径不再外泄，细节落日志）；
  updateSettings 的 api_key_env 对齐 API_KEY_ENV_RE（任意标识符不再被接受）。

发布后第五轮对抗性审查修复（P0+P1 共 20 项，全部配回归测试；
报告见仓库外文档区《对抗性审查报告_2026-09-27_第五轮》）：

### 修复

- Windows 8.3 短名别名绕过资料目录排除：NTFS 为 `.studyclaw` 等长名自动
  生成 `STUDYC~1` 别名，Node realpath 不展开短名、字符串 containment 放行
  → 模型可经短名引用直读课程状态文件；`resolveSourceRef` 与通用文件工具
  统一拒绝 `~数字` 结尾的路径段；
- `.source-root.json` 绑定目标零校验：被污染的仓库可把资料根指到工作区外
  越界读取；绑定限定在 courseDir 内，否则忽略回退项目根；
- progress.md 表头判定误伤数据行：含 `concept_id` 子串的概念行被当表头
  跳过，eval 时该概念掌握度被静默归零且原行被擦除；三处解析器改首单元格
  精确判定；
- 事件日志 append 尾换行丢失：断电/强杀恰落在最后一个 JSON 字节后时，
  新行与末行拼接、两条事件静默丢失；健康分支落盘前补分隔符；
- Agent 恢复顺序倒置：「A 在途 + B 排队」的日志恢复后 B 先跑 A 后跑；
  改单趟有序重建（保留首次入队次序）；
- 聊天 sync 回写锁外竞争 progress.md：与锁内的 eval SM-2 RMW 并发时锁内
  更新被陈旧全量写覆盖；TutorSession 增 courseLock 注入点，宿主注入
  withCourseLock（快写段上锁、LLM 慢调用留在锁外）；
- chatStream requestId 并发重试双发：两个并发同 requestId 调用基于同一旧
  快照都通过"未 void"检查并各自 agent.send（重复 user/input + 双倍计费）；
  判定+新发按 session 串行，且 void 行补带 turnId 收敛链上后到的重试；
- 明文凭据迁移写锁外回滚新 key：readCredentials 的自动 re-seal 包进凭据锁，
  拆出 raw 读取供持锁调用方使用（promise 链锁不可重入）；
- 桌面壳 IPC 透出 Host token：host-info 收敛为 {dev, port}，will-navigate
  收紧为仅本次 Host 实端口；
- 桌面壳重启状态机自锁：startHost 加重入保护、重启计时器句柄化并由
  startHost/stopHost 取关；win32 taskkill 校验退出码；
- CLI 优雅关停必然残留 host.json（含明文 token）与 host.lock：清理改同步
  rm，'exit' 处理器路径同样生效；
- 上传路由客户端断连永不结算：busboy 'close' 在 RST 时不触发，fd 与
  `.upload-*.tmp` 静默泄漏；请求 close + stall 兜底双路结算；
- 交互 CLI 跑完进程挂起：stdin resume 后从不释放；unref + prompt 期间
  ref/结算后 unref；
- `courses.files` 枚举不走排除目录：就地课程根即项目根，node_modules 被
  全量 walk；复用排除集 + 深度/数量双上限；
- 预中止请求仍跑完整回合：入场即 aborted 时直接返回，不死连接白烧 LLM；
- 动态卡缺答案键校验且绕过质量闸：补 superRefine + enforceTaskQuality，
  越界/长度失衡卡不再入池；
- builder atomicWrite 固定 tmp 名并发互踩：随机 tmp；granularity 写段上锁
  且锁内重读；
- 批量生成首败即停：一个单元失败后其余 worker 不再白烧剩余 LLM 调用；
- 唤醒卡作答不传 evalId/signal：SSE 中断重试二次结算且流不可中止；
- quizLoad 落地前不校验 activeCourseId：切课后旧题卡覆盖新课程；
- 大文件上传无取消：uploadFiles 支持 AbortSignal，弹窗关闭即中止；
- `--port abc` 静默回退 8080、`--port 99999` 抛裸栈：统一整数+范围校验；
  `--port 0` 的 host.lock 回填实际端口；
- 匿名 eval 账本 write-only 死状态删除；账本落盘失败留告警（静默吞掉会让
  重试二次计分且无迹可查）。

### 并发与一致性

（同上「修复」中的锁外 RMW 与串行化条目。）

### 内部

- 生成动态卡的 StructuredCallClient 接上 signal 透传缝（工具边界完整穿线
  为后续重构）。

## [0.1.0-beta] - 2026-09-04

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
