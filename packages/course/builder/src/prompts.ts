/**
 * Prompt templates for the builder/learning LLM calls (inlined from the
 * Python `prompts.yaml`: task_generator / evaluator / dynamic_task_generator).
 * @module @studyclaw/course-builder/src/prompts
 */

export const TASK_GENERATOR_SYSTEM = `你是 StudyClaw 的 Harness 出题引擎，职责是把知识切片转化为可严格判定的验证题卡。
硬性要求：
1. 每张题卡的 type 必须三选一：concept（概念辨析）/ scenario（场景决策）/ debug_edge（边界与排错）；
2. evaluation_criteria.rubric 必须给出 2~4 条**互斥**的采分点，每条是一个可独立二元判定（Hit/Miss）的逻辑要点，禁止互相蕴含或重复；
3. evaluation_criteria.keywords 提供判题辅助关键词与典型反例线索；
4. difficulty 为 1~5 整数，与题卡思维层级匹配；
5. 题干必须锚定切片内容，禁止虚构切片之外的事实；
6. 选择题必须给出恰好 4 个 options，并标注 answer_index（正确选项下标，0 起始）；选项硬性要求：
   - 每个选项 ≤60 字、单句陈述；最长与最短选项的字数差不超过 1.5 倍（禁止"正确项最长"）；
   - 干扰项与正确项同构同域，仅在**一个**关键限定/方向/边界上不同（单点错误），禁止明显荒谬的凑数项；
   - answer_index 在同一批内轮换位置，禁止连续落在同一位；
7. 只输出符合给定 Schema 的结构化 JSON，不输出任何解释文字。`

export interface TaskGenerationTarget {
  type: 'concept' | 'scenario' | 'debug_edge'
  difficulty: number
  answerPosition: number
}

export function taskGeneratorUser(
  title: string,
  content: string,
  count: number,
  feedback = '',
  targets?: TaskGenerationTarget[],
): string {
  const targetLines = targets === undefined || targets.length === 0
    ? [`请基于上述切片生成 ${count} 张验证题卡，尽量覆盖不同的 type 层级与难度梯度。`]
    : [
      `请基于上述切片生成 ${count} 张验证题卡，逐张按以下规格生成（type/difficulty/answer_index 必须严格采用指定值）：`,
      ...targets.map((target, index) =>
        `- 第 ${index + 1} 张：type=${target.type}，difficulty=${target.difficulty}，answer_index=${target.answerPosition}`),
    ]
  return [
    '## 知识切片',
    `- 标题：${title}`,
    '- 内容：',
    content,
    '',
    '## 任务',
    ...targetLines,
    feedback === '' ? '' : feedback,
  ].join('\n')
}

export const EVALUATOR_SYSTEM = `你是 StudyClaw 的 Rubric 判题官，执行二元命中判定（Binary Hit Check），不做主观打分、不放水。
硬性要求：
1. judgements 逐条对应 Rubric：顺序与原文完全一致，一条不少、一条不多；
2. hit=true 仅当作答明确覆盖该要点；含糊带过、只提关键词未展开、或与要点相悖，一律 hit=false；
3. feedback 用苏格拉底式引导：先肯定命中的要点，再对未命中要点以追问引导，不直接给出完整答案；
4. misconceptions 列出作答暴露的认知漏洞（可空）；
5. misattribution 从 概念混淆 / 推导漏洞 / 边界遗漏 / 无 中为未命中要点选择首要错因；全部命中时选 无；
6. 只输出符合给定 Schema 的结构化 JSON，不输出任何解释文字。`

export function evaluatorUser(
  question: string,
  rubric: string[],
  studentAnswer: string,
  userMemory = '',
  conceptName = '',
): string {
  return [
    '## 待判定的题卡',
    `- 题目：${question}`,
    conceptName === '' ? '' : `- 概念：${conceptName}`,
    '## Rubric 采分点（顺序与判定必须完全一致）',
    ...rubric.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    '## 学生作答',
    studentAnswer,
    userMemory === '' ? '' : `## 学生历史画像\n${userMemory}`,
  ].join('\n')
}

export const DYNAMIC_CARD_SYSTEM = `你是 StudyClaw 的动态靶向题生成器：基于源题卡与暴露出的误区，生成反例/变体题卡（F5）。
硬性要求：
1. type 必须三选一：concept / scenario / debug_edge；
2. rubric 2~4 条互斥采分点；difficulty 1~5；
3. 题干必须针对 {misconception} 设计变体或反例，禁止与源题重复；
4. 只输出符合给定 Schema 的结构化 JSON，不输出任何解释文字。`

export const DEP_INFER_SYSTEM = `你是 StudyClaw 的课程先修关系标注器，依据概念清单（名称、类型、所属章节与内容摘要）推断概念级学习先修关系。
硬性要求：
1. 只允许引用清单中出现的 conceptId，禁止引用清单之外的 id；
2. 先修关系必须语义明确：学习 B 之前应先掌握 A，才把 A 写入 B 的 prerequisites（A == B 自引用一律禁止）；
3. prerequisites 必须构成无环有向图（依赖方向：先修 → 后继），禁止任何环路；
4. 只标注确定存在的先修关系；无明确先修的概念 prerequisites 返回空数组；
5. 输出必须覆盖清单中的每一个概念；只输出符合给定 Schema 的结构化 JSON，不输出任何解释文字。`

/** 概念清单 → 依赖推断用户提示（内容摘要被截断以控制 token）。 */
export function depInferUser(
  syllabus: { chapters: Array<{ id: string; title: string; concepts: Array<{ id: string; name: string; type: string }> }> },
  chunks: ReadonlyMap<string, string>,
  snippetLimit = 300,
): string {
  const lines = ['## 概念清单（id | 名称 | 类型 | 所属章节 | 内容摘要）']
  for (const chapter of syllabus.chapters) {
    for (const concept of chapter.concepts) {
      const snippet = (chunks.get(concept.id) ?? '').replace(/\s+/g, ' ').slice(0, snippetLimit)
      lines.push(`- ${concept.id} | ${concept.name} | ${concept.type} | ${chapter.title}${snippet === '' ? '' : ` | ${snippet}`}`)
    }
  }
  lines.push('', '## 任务', '请为上述每个概念标注 prerequisites（先修概念 id 列表）。没有先修的写空数组；注意保持无环。')
  return lines.join('\n')
}

export function dynamicCardUser(sourceQuestion: string, sourceRubric: string[], misconception: string): string {
  return [
    '## 源题卡',
    `- 题目：${sourceQuestion}`,
    '## Rubric',
    ...sourceRubric.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    `## 暴露出的误区/盲点`,
    misconception,
  ].join('\n')
}
