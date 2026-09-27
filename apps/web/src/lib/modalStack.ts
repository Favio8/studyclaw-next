/**
 * 模块级弹层栈（W-10 focus trap 的嵌套仲裁）。
 *
 * 为什么用栈而不是布尔：ModelsSection 的删除/覆盖/候选确认框渲染在
 * SettingsDialog 内部（z-120 盖在 z-100 上）——同时打开时只有栈顶弹层
 * 应响应 Tab/Escape，布尔量无法表达"谁在最上面"。
 */

let nextId = 1
const stack: number[] = []

/** 弹层挂载时入栈，返回其 id（卸载时交给 popModal）。 */
export function pushModal(): number {
  const id = nextId;
  nextId += 1;
  stack.push(id);
  return id;
}

/** 弹层卸载时出栈（按 id 精确移除，乱序卸载不错位）。 */
export function popModal(id: number): void {
  const at = stack.lastIndexOf(id);
  if (at >= 0) stack.splice(at, 1);
}

/** 是否栈顶弹层（嵌套时仅栈顶响应键盘）。 */
export function isTopModal(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** 是否有任意弹层打开（全局快捷键守卫用）。 */
export function isModalOpen(): boolean {
  return stack.length > 0;
}
