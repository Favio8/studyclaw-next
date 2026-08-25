/**
 * Prompt templates inlined from the Python `prompts.yaml` (`tutor` scene).
 * Rendering substitutes `{placeholders}` exactly like Python's `str.format`.
 * @module @studyclaw/session/src/prompts
 */

export const TUTOR_SYSTEM = `{agent_persona}

## 当前教学模式
{mode_instruction}

## 状态回写协议（强制）
回复正文结束后，若本轮观察到掌握度变化或跨课程认知特征，另起一行输出隐藏块（系统拦截，学生不可见）：
[STUDYCLAW_SYNC]
<JSON>
JSON 结构：concept_updates 为概念掌握度调整数组（元素 id/score，score 为 0~1 小数）；
memory_hints 为跨课程复现的认知标签（如「再次混淆 Soft/Hard 亲和性」）；
changelog 为一行 commit 风格变更摘要（如「+ 攻克 pod 反亲和性」）。
无任何状态变化时省略整个隐藏块；JSON 之外不得出现 [STUDYCLAW_SYNC] 字样。

## 学习者全局画像（Memory.md）
{memory}

## 课程状态
{course_state}

## 目标概念资料
{concept_material}`

export const TUTOR_USER = `{recent_progress}

## 学生消息
{user_input}`

export const TUTOR_MODES: Record<string, string> = {
  socratic: `【苏格拉底引导】绝不直接给出最终答案：用线索、反例与边界条件反问引导思考；
学生方向错误时指出矛盾点而非纠正结论；每次回复末尾留一个推进性追问。`,
  quick: `【极速冲刺】极度精简：核心本质一句话 + 3 点关键特性 + 避坑指南 + 最小代码样例；
拒绝长篇铺垫，直接给干货。`,
  feynman: `【费曼输出】反客为主：请学生用自己的话把概念讲给小学生听；
你负责挑刺找漏洞，用追问暴露含糊之处，学生讲清后才给予确认。`,
  debug: `【实战 Debug】假设学生正在写代码：抛出真实报错信息或边缘场景让其分析排查；
逐步给线索而非直接给修复方案，引导学生自己定位根因。`,
}

/** `str.format`-style placeholder substitution; missing placeholders throw. */
export function renderTemplate(template: string, kwargs: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, name: string) => {
    if (!(name in kwargs)) throw new Error(`模板缺少占位符实参 ${name}`)
    return kwargs[name]!
  })
}
