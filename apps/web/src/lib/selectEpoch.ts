/**
 * 会话选择纪元 + 自动选会话抑制（UI-9/A7）。
 *
 * A7（第三轮审查）：此前该状态挂在 useSessionActions.ts，而 sessionActions.ts
 * 需要反向导入 suppressAutoSelectOnce，形成模块循环（运行时因函数声明提升
 * 而安全，但属卫生隐患）。下沉到独立 lib 模块，双方单向依赖。
 *
 * 语义：
 * - bumpSelectEpoch()：每次用户主动选择会话时递增并取得本回合纪元；
 * - peekSelectEpoch()：读取当前纪元（恢复响应返回时比较，晚到者放弃落地）；
 * - suppressAutoSelectOnce(courseId) / consumeSuppress(courseId)：
 *   "切项目同时明确了目标会话/新建对话"的交互先设置标记，自动选会话
 *   effect 读到同课程标记时跳过一次（防止列表第一条晚到覆盖显式选择）。
 */

let selectEpoch = 0;
let suppressAutoSelectCourse: string | null = null;

export function bumpSelectEpoch(): number {
  selectEpoch += 1;
  return selectEpoch;
}

export function peekSelectEpoch(): number {
  return selectEpoch;
}

export function suppressAutoSelectOnce(courseId: string): void {
  suppressAutoSelectCourse = courseId;
}

/** effect 消费标记：仅当课程匹配时抑制一次并清除。 */
export function consumeSuppress(courseId: string): boolean {
  if (suppressAutoSelectCourse === courseId) {
    suppressAutoSelectCourse = null;
    return true;
  }
  return false;
}
