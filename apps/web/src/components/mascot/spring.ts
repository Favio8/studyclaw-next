/**
 * 弹簧内核（自研实现，通用阻尼谐振子半隐式欧拉积分）。
 *
 * 数学：dv = (-2·d·f·v - f²·(x-t))·dt；x += v·dt。f=固有频率(rad/s)，
 * d=阻尼比。与任何第三方实现无字节/命名渊源（红线：不搬运 grok-icon-study）。
 *
 * 纯函数模块，不依赖 DOM/React，可直接单测。
 */

/** 引擎固定积分步长（秒）：主帧 dt 按此切分子步，保证不同帧率下轨迹一致。 */
export const STEP_DT = 1 / 120;

/** 单个弹簧状态：x 当前值、v 速度、t 目标值。 */
export interface Spring {
  x: number;
  v: number;
  t: number;
}

export function mkSpring(x: number): Spring {
  return { x, v: 0, t: x };
}

/**
 * 推进一个弹簧一个子步。任何非有限值（NaN/±Inf）一律兜底归位到目标，
 * 防止脏输入把整个引擎带崩（评审遗留防护，单测覆盖）。
 */
export function stepSpring(s: Spring, f: number, d: number, dt: number): void {
  s.v += (-2 * d * f * s.v - f * f * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
}

/** 硬赋值到目标（reduced-motion 降级路径：跳过物理，直接摆 pose）。 */
export function snap(s: Spring): void {
  s.x = s.t;
  s.v = 0;
}

export function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, n));
}

/** [a,b) 区间均匀随机（眨眼/扫视/耳抽动的错拍来源）。 */
export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
