/**
 * 动效参数表：弹簧参数、眨眼/扫视/耳抽动/HOP 关键帧、六态 pose 数值。
 * 全部数值从评审定稿原型（claw_animated_optionB.html）整理搬运，禁止手改；
 * 本模块保持纯数据 + 纯函数（无 DOM/React），便于单测。
 */

import type { MascotState } from "./types";
import type { Spring } from "./spring";

/** 弹簧名（显式联合，避免与 SPRINGS 表互相推导成循环类型）。 */
export type SpringName =
  | "bob"
  | "spin"
  | "sqx"
  | "sqy"
  | "headT"
  | "earL"
  | "earR"
  | "lidL"
  | "lidR"
  | "gx"
  | "gy"
  | "pawL"
  | "pawR"
  | "tail"
  | "mouth";

/**
 * 弹簧参数表（key → [固有频率 f, 阻尼比 d]）。
 * 来源：原型 frame() 内逐条 stepSpring 调用的 [freq, damp] 实参。
 */
export const SPRINGS: Record<SpringName, readonly [number, number]> = {
  bob: [4, 0.8],
  spin: [4.2, 0.72],
  sqx: [7.5, 0.64],
  sqy: [7.5, 0.64],
  headT: [5, 0.6],
  earL: [18, 1],
  earR: [18, 1],
  lidL: [26, 1],
  lidR: [26, 1],
  gx: [15, 0.85],
  gy: [15, 0.85],
  pawL: [9, 0.5],
  pawR: [9, 0.5],
  tail: [3.4, 0.5],
  mouth: [7, 0.8],
};

export const SPRING_NAMES = Object.keys(SPRINGS) as SpringName[];

/** * icon 档弹簧子集（评审结论：小尺寸只保留核心五弹簧，其余硬赋值目标，
 * 省下约一半步进量——消息列表同屏 20+ 实例时的帧预算兜底）。
 */
export const ICON_SPRINGS: ReadonlySet<SpringName> = new Set([
  "bob",
  "spin",
  "sqx",
  "sqy",
  "lidL",
  "lidR",
]);

/* ── 眨眼 ──────────────────────────────────────────────────────────── */

/** 单次眨眼关键帧（相对触发时刻的 ms 偏移 → 眼睑 scaleY 目标）。 */
export const BLINK_KEYFRAMES: readonly BlinkKeyframe[] = [
  { at: 0, v: 0.06 },
  { at: 58, v: 0.06 },
  { at: 132, v: 1.09 },
  { at: 262, v: 1 },
];

/** 16% 概率追加的二次眨眼（"错拍灵动感"，icon 档裁掉）。 */
export const BLINK_DOUBLE_KEYFRAMES: readonly BlinkKeyframe[] = [
  { at: 330, v: 0.06 },
  { at: 430, v: 1 },
];

export const BLINK_DOUBLE_PROB = 0.16;

/** 两次眨眼的随机间隔区间（ms）。 */
export const BLINK_INTERVAL_MS: readonly [number, number] = [4000, 9000];

export interface BlinkKeyframe {
  at: number;
  v: number;
}

/* ── 耳朵抽动（方案B） ─────────────────────────────────────────────── */

/** 耳抽动目标序列（ms 偏移 → 角度；左耳正值=向内摆）。 */
export const EAR_TWITCH_SEQ: readonly { at: number; v: number }[] = [
  { at: 0, v: 7 },
  { at: 70, v: -5 },
  { at: 150, v: 3 },
  { at: 230, v: 0 },
];

/** 单耳左 / 单耳右 / 双耳向内 的触发概率分界（与原型一致）。 */
export const EAR_TWITCH_BRANCH = { left: 0.42, right: 0.84 } as const;

/** 耳抽动的随机间隔区间（ms），仅 idle 态触发。 */
export const EAR_TWITCH_INTERVAL_MS: readonly [number, number] = [3000, 7000];

/* ── HOP（celebrate 跳跃，reduced-motion 禁用） ────────────────────── */

/** 四段衰减跳跃：每段 [高度 px, 时长 s]，抛物线 -4h·u·(1-u)。 */
export const HOP_SEGS: readonly { h: number; d: number }[] = [
  { h: 42, d: 0.44 },
  { h: 24, d: 0.35 },
  { h: 11, d: 0.25 },
  { h: 4.5, d: 0.16 },
];

export const HOP_TOTAL_S = HOP_SEGS.reduce((s, x) => s + x.d, 0);

/** hop 触发后经过 t 秒的 y 偏移；结束返回 null（调用方清除 hop 起点）。 */
export function hopY(at: number, now: number): number | null {
  if (at < 0) return 0;
  const t = (now - at) / 1000;
  if (t >= HOP_TOTAL_S) return null;
  let acc = 0;
  for (const seg of HOP_SEGS) {
    if (t < acc + seg.d) {
      const u = (t - acc) / seg.d;
      return -4 * seg.h * u * (1 - u);
    }
    acc += seg.d;
  }
  return 0;
}

/* ── 六态 pose（原型 applyPose 数值原样搬运） ───────────────────────── */

/** 一帧的 pose 目标集（弹簧的 t 值来源）。 */
export interface PoseTarget {
  bob: number;
  spin: number;
  sqx: number;
  sqy: number;
  headT: number;
  lid: number;
  gx: number;
  gy: number;
  pawL: number;
  pawR: number;
  tail: number;
  mouth: number;
}

/**
 * 计算某状态在时刻 ph（组件存活秒数）/ dtS（进入当前状态秒数）的 pose 目标。
 * reduced-motion 时调用方固定传 ph=0, dtS=0 → 各状态得到静态标准姿态。
 *
 * 数值逐条对照原型 applyPose，六态均已评审验证。
 */
export function poseTargets(state: MascotState, ph: number, dtS: number): PoseTarget {
  const P: PoseTarget = {
    bob: 0,
    spin: 0,
    sqx: 1,
    sqy: 1,
    headT: 0,
    lid: 1,
    gx: 0,
    gy: 0,
    pawL: 0,
    pawR: 0,
    tail: 0,
    mouth: 1,
  };
  switch (state) {
    case "idle":
      P.bob = Math.sin(ph * 0.9) * 1.4;
      P.spin = Math.sin(ph * 0.4) * 1.2;
      P.sqy = 1 + Math.sin(ph * 0.9) * 0.008;
      P.sqx = 1 - Math.sin(ph * 0.9) * 0.006;
      P.tail = Math.sin(ph * 0.8) * 7;
      break;
    case "listening":
      P.headT = -4;
      P.lid = 1.12;
      P.bob = -1.5;
      P.tail = Math.sin(ph * 1.6) * 5;
      break;
    case "thinking":
      P.headT = 6;
      P.gx = -0.55;
      P.gy = -0.6;
      P.lid = 0.8;
      P.tail = Math.sin(ph * 0.5) * 4;
      P.bob = 1;
      break;
    case "writing": {
      const b = ph * 5.4;
      P.bob = 2 - Math.abs(Math.sin(b)) * 1.6;
      P.lid = 0.62;
      P.headT = 3;
      P.pawL = Math.sin(b) * 6;
      P.pawR = Math.sin(b + Math.PI) * 6;
      P.tail = Math.sin(ph * 1.2) * 4;
      break;
    }
    case "celebrate":
      if (dtS < 0.16) {
        P.bob = 5 * (dtS / 0.16);
        P.sqy = 1 - 0.04 * (dtS / 0.16);
      }
      P.lid = 1;
      // 举爪 -26（原型值）会盖住嘴线并压到吻部下缘（评审 P2 项）；
      // 收到 -14：嘴部完整露出，爪尖贴在腮边，庆祝语义不变
      P.pawL = -14;
      P.pawR = -14;
      P.mouth = 1.6;
      P.spin = Math.sin(ph * 2.6) * 3;
      P.tail = Math.sin(ph * 3) * 10;
      break;
    case "alerting":
      P.lid = 1.25;
      P.bob = 3.5;
      P.sqx = 1.02;
      P.sqy = 0.98;
      P.spin = Math.sin(ph * 12) * 1.5;
      P.tail = 18;
      P.mouth = 1.5;
      break;
    /* ── 以下 P1 八态为按既有姿态词汇的新设计（设计文档 §7.2），未经原型评审 ── */
    case "sleeping":
      // 闭眼横线、极缓呼吸（不眨眼由引擎保证）；6-10s 级慢周期
      P.lid = 0.06;
      P.headT = 3;
      P.bob = Math.sin(ph * 0.5) * 0.8;
      P.sqy = 1 + Math.sin(ph * 0.5) * 0.005;
      P.sqx = 1 - Math.sin(ph * 0.5) * 0.004;
      P.tail = Math.sin(ph * 0.3) * 3;
      break;
    case "waking":
      // 惊醒→归位（约 1.8s 过渡）；强制双眨队列由引擎注入
      P.lid = 1.2;
      P.headT = -2 * (1 - Math.min(dtS / 1.8, 1));
      P.bob = -2 * (1 - Math.min(dtS / 0.5, 1));
      P.tail = Math.sin(ph * 2.2) * 6;
      break;
    case "searching":
      // 眼左右扫 + 单爪前探；眨眼偏快区间由调用方节律控制
      P.lid = 1.05;
      P.headT = -2;
      P.gx = Math.sin(ph * 3) * 1.2;
      P.gy = -0.3;
      P.pawL = -4 + Math.sin(ph * 2) * 4;
      P.tail = Math.sin(ph * 1.2) * 5;
      P.bob = 0.5;
      break;
    case "working":
      // 双爪交替搬卡、低头看
      P.lid = 0.75;
      P.headT = 4;
      P.bob = 1 + Math.sin(ph * 3) * 0.8;
      P.pawL = Math.sin(ph * 3) * 8;
      P.pawR = Math.sin(ph * 3 + Math.PI) * 8;
      P.tail = Math.sin(ph * 1.5) * 4;
      break;
    case "uploading":
      // 双爪上举微晃、仰头看进度
      P.lid = 1;
      P.headT = -2;
      P.bob = Math.sin(ph * 2) * 1;
      P.pawL = -18 + Math.sin(ph * 2) * 3;
      P.pawR = -18 - Math.sin(ph * 2) * 3;
      P.mouth = 1.2;
      break;
    case "asking":
      // 单爪前伸递出、期待圆眼
      P.lid = 1.15;
      P.headT = 3;
      P.gy = 0.2;
      P.pawL = -10;
      P.tail = Math.sin(ph * 0.9) * 4;
      P.bob = 0.5;
      break;
    case "encourage":
      // 委屈歪头、双爪轻拍加油（与 alerting 严格区分：是加油不是报错）
      P.lid = 0.85;
      P.headT = -3;
      P.gx = 0.2;
      P.pawL = -6 + Math.sin(ph * 4) * 5;
      P.pawR = -6 - Math.sin(ph * 4) * 5;
      P.mouth = 0.9;
      P.tail = Math.sin(ph * 0.8) * 3;
      break;
    case "progress":
      // 双爪悬吊（吊环感）、目光固定
      P.lid = 0.9;
      P.bob = Math.sin(ph * 1.5) * 1;
      P.pawL = -20 + Math.sin(ph * 2.5) * 4;
      P.pawR = -20 - Math.sin(ph * 2.5) * 4;
      break;
  }
  return P;
}

/* ── 弹簧初始化（与原型 mkSpring 初值一致，保证首帧=静置姿态） ──────── */

/** 弹簧初始值：比例类（squash/眼睑/嘴）静止为 1，其余为 0。 */
const SPRING_INIT: Record<SpringName, number> = {
  bob: 0,
  spin: 0,
  sqx: 1,
  sqy: 1,
  headT: 0,
  earL: 0,
  earR: 0,
  lidL: 1,
  lidR: 1,
  gx: 0,
  gy: 0,
  pawL: 0,
  pawR: 0,
  tail: 0,
  mouth: 1,
};

export function mkSprings(): Record<SpringName, Spring> {
  const out = {} as Record<SpringName, Spring>;
  for (const name of SPRING_NAMES) {
    out[name] = { x: SPRING_INIT[name], v: 0, t: SPRING_INIT[name] };
  }
  return out;
}
