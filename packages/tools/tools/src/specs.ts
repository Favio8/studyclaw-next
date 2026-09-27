/**
 * Default tool specification set (all 13 tools from Python
 * `agent_tools.py::build_default_specs`). Handlers are registered in
 * `index.ts`; host-side learning actions are supplied through ToolContext.
 * @module @studyclaw/tools/src/specs
 */

export type ToolPolicy = 'read' | 'action' | 'write' | 'interactive'
export type ToolExecution = 'parallel' | 'exclusive'

/** Stable UI/provider hint consumed by ToolRow and capability diagnostics. */
export type ToolRenderIntent = 'file' | 'search' | 'course' | 'memory' | 'card' | 'quiz' | 'evaluation' | 'sync' | 'note' | 'question' | 'shell' | 'network' | 'plan' | 'todo' | 'subagent' | 'warning'

/** One registry entry: schema/policy/timeout description (handler registered separately). */
export interface ToolSpec {
  readonly name: string
  readonly parameters: Record<string, unknown>
  readonly description: string
  readonly policy: ToolPolicy
  readonly timeout: number
  readonly execution: ToolExecution
  readonly renderIntent: ToolRenderIntent
  readonly retry: { readonly maxRetries: number; readonly backoffMs: number }
  /** Whether this tool represents an external side effect requiring approval. */
  readonly requiresApproval?: boolean
  readonly provider?: 'subprocess' | 'network' | 'subagent' | 'sandbox' | 'lsp'
}

export const DEFAULT_TOOL_TIMEOUT = 5
const ACTION_TIMEOUT_LLM = 30
const ACTION_TIMEOUT_SYNC = 300

/** The tool that reports the loop-limit rejection (chat loop sends this event). */
export const LOOP_LIMIT_NAME = '__tool_loop_limit__'
export const MAX_PARALLEL_TOOL_CALLS = 5

export const MAX_READ_LINES = 200
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_NOTE_CHARS = 4000
export const MAX_TOOL_MESSAGE_CHARS = 4000

const spec = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  policy: ToolPolicy = 'read',
  timeout = DEFAULT_TOOL_TIMEOUT,
): ToolSpec => {
  const provider = name === 'run_command' ? 'subprocess' as const
    : name === 'fetch_url' || name === 'search_web' ? 'network' as const
      : name === 'spawn_agent' ? 'subagent' as const
        : name === 'lsp' ? 'lsp' as const
        : undefined
  const renderIntent: ToolRenderIntent = name.includes('search') ? 'search'
    : name.includes('source') || name.endsWith('_file') ? 'file'
      : name.includes('memory') ? 'memory'
        : name.includes('card') ? 'card'
          : name.includes('quiz') || name.includes('review') ? 'quiz'
            : name.includes('evaluate') ? 'evaluation'
              : name.includes('sync') ? 'sync'
                : name.includes('note') ? 'note'
                  : name.includes('question') ? 'question'
                    : name === 'run_command' ? 'shell'
                      : name.includes('fetch') || name.includes('web') ? 'network'
                        : name === 'plan' ? 'plan'
                          : name === 'todo' ? 'todo'
                            : name === 'spawn_agent' ? 'subagent'
                              : name.startsWith('__') ? 'warning' : 'course'
  return {
    name,
    description,
    parameters,
    policy,
    timeout,
    execution: policy === 'read' ? 'parallel' : 'exclusive',
    renderIntent,
    retry: { maxRetries: 0, backoffMs: 100 },
    requiresApproval: policy !== 'read' && !['ask_user_question', 'run_review', 'run_quiz', 'plan', 'todo'].includes(name),
    ...(provider === undefined ? {} : { provider }),
  }
}

/** The default registry inventory, matching Python's build_default_specs. */
export function buildDefaultSpecs(): ToolSpec[] {
  return [
    spec(
      'read_source',
      '按行读取课程源文件/切片（限长，课程资料根内相对路径）',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '课程资料根目录下的相对路径，如 docs/scheduler.md' },
          startLine: { type: 'integer', minimum: 1, description: '起始行号（1-based），缺省 1' },
          endLine: { type: 'integer', minimum: 1, description: '结束行号（闭区间），缺省文件末尾' },
          maxLines: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: '返回行数上限' },
        },
        required: ['path'],
      },
    ),
    spec(
      'search_sources',
      'glob+grep 搜索课程资料中的概念/章节/关键词，返回文件+行号',
      {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: '要搜索的关键词/概念名' },
          maxResults: { type: 'integer', minimum: 1, maximum: 50, description: '返回匹配条数上限' },
          caseSensitive: { type: 'boolean', description: '是否大小写敏感，缺省 false' },
        },
        required: ['query'],
      },
    ),
    spec('get_course_state', '课程状态快照：大纲/掌握度/到期/薄弱点', { type: 'object', properties: {} }),
    spec('get_task_pool', '题卡池概况（数量/类型/难度/概念分布；不含题面与答案）', {
      type: 'object',
      properties: {
        conceptId: { type: 'string', description: '可选，只看某概念所属题卡' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    }),
    spec('get_memory', '全局学习画像与当前课程错因池查询', { type: 'object', properties: {} }),
    spec(
      'create_card',
      '把一段精妙段落转成永久复习卡（F4）并入池；结果只回新卡元数据',
      {
        type: 'object',
        properties: {
          // T-8：content 原无上限——超长串直灌 prompt，成本可被半可信 LLM 放大。
          content: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS, description: '想转成复习卡的段落内容（≤4000 字符）' },
          title: { type: 'string', description: '可选，卡片标题（缺省由内容推导）' },
          conceptId: { type: 'string', description: '可选，归属概念 ID；缺省 slug 推导' },
          count: { type: 'integer', minimum: 1, maximum: 5, description: '生成张数，缺省 1' },
        },
        required: ['content'],
      },
      'action',
      ACTION_TIMEOUT_LLM,
    ),
    spec(
      'generate_dynamic_card',
      '针对答辩误区生成动态变体/反例题（F5）并入池（不污染静态池）',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, description: '源题卡 task_id（以此卡为基底变体）' },
          // T-8：misconception/content 原无上限（write_note 有）——超长串直灌 prompt。
          misconception: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS, description: '暴露出的误区/盲点描述（≤4000 字符）' },
          content: { type: 'string', maxLength: MAX_NOTE_CHARS, description: '可选，覆盖源题内容片段（≤4000 字符）' },
          targetId: { type: 'string', description: '可选，target_id（缺省 dynamic:<源题>）' },
          count: { type: 'integer', minimum: 1, maximum: 5, description: '生成张数，缺省 1' },
        },
        required: ['taskId', 'misconception'],
      },
      'action',
      ACTION_TIMEOUT_LLM,
    ),
    spec('run_review', '拉今日到期复习题（题面+选项，无答案/rubric）', {
      type: 'object',
      properties: {
        conceptId: { type: 'string', description: '可选，只看某概念' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '题数，缺省 1' },
      },
    }, 'action', ACTION_TIMEOUT_LLM),
    spec('run_quiz', '拉起到期/新题卡开练（题面+选项，无答案/rubric）', {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['review', 'new'], description: 'review=到期优先 / new=新题（前置解锁），缺省 review' },
        conceptId: { type: 'string', description: '可选，只看某概念' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '题数，缺省 1' },
      },
    }, 'action', ACTION_TIMEOUT_LLM),
    spec(
      'evaluate_answer',
      'Rubric 判定学生作答；只回通过/未通过 + 苏格拉底式引导摘要（零泄题）',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, description: '被作答的题卡 task_id' },
          // T-8：answer 原无上限——学生/模型灌入的超长作答直通判题 prompt。
          answer: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS, description: '学生的作答文本（≤4000 字符）' },
        },
        required: ['taskId', 'answer'],
      },
      'action',
      ACTION_TIMEOUT_LLM,
    ),
    spec('sync_sources', '按需增量 build/索引（CourseBuilder）；只回 diff 概况', {
      type: 'object',
      properties: {},
    }, 'action', ACTION_TIMEOUT_SYNC),
    spec(
      'write_note',
      '给学生课程笔记追加一行（append-only；绝不改写既有内容，不写全局 Memory）',
      {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS, description: '学生当前轮想记录的一句笔记（≤4000 字符）' },
          conceptId: { type: 'string', description: '可选，笔记归属概念 ID（c_[A-Za-z0-9_]+），随行前缀' },
          chapterId: { type: 'string', description: '可选，笔记归属章节 ID（chap_[A-Za-z0-9_]+）' },
        },
        required: ['content'],
      },
      'write',
    ),
    spec(
      'ask_user_question',
      '向学生提出澄清/引导问题（不代答；本轮挂起等待学生回答）',
      {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS, description: '要向学生澄清/引导的问题文本（≤4000 字符）' },
        },
        required: ['question'],
      },
      'interactive',
    ),
  ]
}

/** DSH-style generic filesystem tool inventory. Learning tools remain a
 * separate preset so legacy mode filtering stays unchanged. */
export function buildGenericSpecs(): ToolSpec[] {
  return [
    spec('read_file', '读取工作区内的 UTF-8 文本文件（限长）', {
      type: 'object', properties: { path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES } }, required: ['path'],
    }),
    spec('search_files', '在工作区内搜索文本文件中的关键词', {
      type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'],
    }),
    spec('write_file', '写入工作区内的 UTF-8 文本文件（需要用户确认）', {
      type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string', maxLength: MAX_TOOL_MESSAGE_CHARS * 4 } }, required: ['path', 'content'],
    }, 'write', ACTION_TIMEOUT_SYNC),
    spec('run_command', '通过部署 Provider 执行工作区命令（无 Provider 时 degraded）', {
      type: 'object', properties: { command: { type: 'string', minLength: 1 } }, required: ['command'],
    }, 'action', ACTION_TIMEOUT_SYNC),
    spec('fetch_url', '通过受控网络 Provider 获取 URL（拒绝隐式本机 fetch）', {
      type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'],
    }, 'action', ACTION_TIMEOUT_SYNC),
    spec('search_web', '通过受控网络 Provider 搜索网页', {
      type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'],
    }, 'action', ACTION_TIMEOUT_SYNC),
    spec('plan', '更新 Agent 当前执行计划', {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              { type: 'string', minLength: 1 },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
              },
            ],
          },
        },
      },
      required: ['steps'],
    }, 'action'),
    spec('todo', '更新 Agent 当前待办状态', {
      type: 'object', properties: { items: { type: 'array', items: { type: 'object' }, minItems: 1 } }, required: ['items'],
    }, 'action'),
    spec('spawn_agent', '调度子 Agent（需要宿主 Provider）', {
      type: 'object', properties: { task: { type: 'string', minLength: 1 } }, required: ['task'],
    }, 'action', ACTION_TIMEOUT_SYNC),
    spec('lsp', '通过语言服务器进行精确代码导航（定义、引用、实现或悬停）', {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['goToDefinition', 'findReferences', 'goToImplementation', 'hover'] },
        file_path: { type: 'string', minLength: 1 },
        line: { type: 'integer', minimum: 1 },
        character: { type: 'integer', minimum: 1 },
      },
      required: ['operation', 'file_path', 'line', 'character'],
    }, 'read', 60),
  ]
}
