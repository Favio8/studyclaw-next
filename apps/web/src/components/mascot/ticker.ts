/**
 * 模块级共享 ticker：全应用唯一一个 requestAnimationFrame 循环，
 * 驱动所有爪爪实例（长会话 20+ 实例的帧预算兜底，§6 硬约束 2）。
 *
 * 引用计数语义：首个订阅者加入时启动循环，最后一个退出时取消；
 * 单帧 dt 钳制 0..0.25s（标签页恢复瞬间防跳变）。
 */

type TickFn = (now: number, dt: number) => void;

const subs = new Set<TickFn>();
let raf = 0;
let last = 0;

function clampDt(seconds: number): number {
  return Math.min(0.25, Math.max(0, seconds));
}

function tick(now: number): void {
  const dt = clampDt((now - last) / 1000);
  last = now;
  for (const fn of subs) fn(now, dt);
  raf = subs.size > 0 ? requestAnimationFrame(tick) : 0;
}

/** 加入帧循环（幂等：重复 add 同一引用无副作用）。 */
export function addTick(fn: TickFn): void {
  subs.add(fn);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

/** 退出帧循环；订阅清零即取消底层 RAF。 */
export function removeTick(fn: TickFn): void {
  subs.delete(fn);
  if (subs.size === 0 && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** 当前订阅者数量（单测断言"卸载后订阅归零"用）。 */
export function tickSubscriberCount(): number {
  return subs.size;
}
