"use client";

/**
 * 爪爪动效引擎（React 挂载层，§6 硬约束逐条落实）：
 *
 * 1. 弹簧绝不进 React state：全部 useRef，RAF 里直接 setAttribute；
 * 2. 共享单一 ticker：模块级单 RAF（ticker.ts），本模块只订阅/退订；
 * 3. 三条件退订：IntersectionObserver 离屏 / 标签页隐藏 / idle 超过 5 分钟
 *    ——任一命中即 removeTick，恢复时重订；
 * 4. reduced-motion 语义：prefers-reduced-motion 时弹簧硬赋值到目标
 *    （ph/dtS 冻结为 0 → 静态标准姿态），并禁用 hop 与耳抽动；
 * 5. SSR/Hydration 安全：RAF 只在 useEffect（客户端挂载后）启动，
 *    首帧 = JSX 确定性静态骨架，服务端输出与客户端首帧一致；
 * 6. 帧行为全部从评审定稿原型（claw_animated_optionB.html）逐条搬运。
 */

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { EYE, PIVOT } from "./geometry";
import {
  addTick,
  removeTick,
} from "./ticker";
import { clamp, rand, stepSpring, snap, STEP_DT, type Spring } from "./spring";
import {
  BLINK_DOUBLE_KEYFRAMES,
  BLINK_DOUBLE_PROB,
  BLINK_INTERVAL_MS,
  BLINK_KEYFRAMES,
  EAR_TWITCH_BRANCH,
  EAR_TWITCH_INTERVAL_MS,
  EAR_TWITCH_SEQ,
  ICON_SPRINGS,
  mkSprings,
  poseTargets,
  hopY,
  SPRINGS,
  SPRING_NAMES,
  type SpringName,
} from "./tables";
import type { MascotState, MascotTier } from "./types";

/** idle 超过多久退订帧循环（§6-3：实例静止且无 pulse 超 5 分钟）。 */
const IDLE_UNSUBSCRIBE_MS = 5 * 60_000;

/** Clawzy.tsx 渲染的可动部件 refs（icon 档部分元素不渲染，对应 ref 为 null）。 */
export interface MascotPartRefs {
  svg: RefObject<SVGSVGElement | null>;
  root: RefObject<SVGGElement | null>;
  tail: RefObject<SVGGElement | null>;
  head: RefObject<SVGGElement | null>;
  earLB: RefObject<SVGGElement | null>;
  earRB: RefObject<SVGGElement | null>;
  earLF: RefObject<SVGGElement | null>;
  earRF: RefObject<SVGGElement | null>;
  eyeLGrp: RefObject<SVGGElement | null>;
  eyeLInner: RefObject<SVGGElement | null>;
  eyeRGrp: RefObject<SVGGElement | null>;
  eyeRInner: RefObject<SVGGElement | null>;
  pawL: RefObject<SVGGElement | null>;
  pawR: RefObject<SVGGElement | null>;
  mouth: RefObject<SVGGElement | null>;
}

interface BlinkFrame {
  at: number;
  v: number;
}
interface EarFrame {
  at: number;
  vL: number;
  vR: number;
}

/** 引擎运行时（全部 mutable，避开 React 渲染路径）。 */
interface EngineRuntime {
  springs: Record<SpringName, Spring>;
  t0: number;
  stateAt: number;
  seenState: MascotState;
  blinkQueue: BlinkFrame[];
  blinkUntil: number;
  blinkVal: number;
  saccadeUntil: number;
  fx: number;
  fy: number;
  earTwitchUntil: number;
  earQueue: EarFrame[];
  earTL: number;
  earTR: number;
  hopAt: number;
}

function queueBlink(queue: BlinkFrame[], now: number, allowDouble: boolean): void {
  for (const frame of BLINK_KEYFRAMES) queue.push({ at: now + frame.at, v: frame.v });
  if (allowDouble && Math.random() < BLINK_DOUBLE_PROB) {
    for (const frame of BLINK_DOUBLE_KEYFRAMES) queue.push({ at: now + frame.at, v: frame.v });
  }
}

function consumeBlink(queue: BlinkFrame[], now: number): number | null {
  let value: number | null = null;
  while (queue.length > 0 && now >= queue[0].at) value = queue.shift()!.v;
  return value;
}

/** 耳抽动目标序列：+7° → -5° → +3° → 0；随机单耳或双耳向内（左耳正=向内摆）。 */
function queueEarTwitch(queue: EarFrame[], now: number): void {
  const roll = Math.random();
  for (const step of EAR_TWITCH_SEQ) {
    if (roll < EAR_TWITCH_BRANCH.left) queue.push({ at: now + step.at, vL: step.v, vR: 0 });
    else if (roll < EAR_TWITCH_BRANCH.right) queue.push({ at: now + step.at, vL: 0, vR: -step.v });
    else queue.push({ at: now + step.at, vL: step.v, vR: -step.v });
  }
}

function consumeEar(queue: EarFrame[], now: number): EarFrame | null {
  let last: EarFrame | null = null;
  while (queue.length > 0 && now >= queue[0].at) last = queue.shift()!;
  return last;
}

export function useMascotEngine(
  refs: MascotPartRefs,
  state: MascotState,
  tier: MascotTier,
): void {
  // 运行时只在首挂创建（含 performance.now 初值，SSR 不会执行到这里）
  const runtimeRef = useRef<EngineRuntime | null>(null);
  if (runtimeRef.current === null) {
    const now = performance.now();
    runtimeRef.current = {
      springs: mkSprings(),
      t0: now,
      stateAt: now,
      seenState: state,
      blinkQueue: [],
      blinkUntil: now + rand(BLINK_INTERVAL_MS[0], BLINK_INTERVAL_MS[1]),
      blinkVal: 1,
      saccadeUntil: now + 400,
      fx: 0,
      fy: 0,
      earTwitchUntil: now + rand(EAR_TWITCH_INTERVAL_MS[0], EAR_TWITCH_INTERVAL_MS[1]),
      earQueue: [],
      earTL: 0,
      earTR: 0,
      hopAt: -1,
    };
  }

  // 最新 props 经 ref 进入帧循环（不触发重渲染）
  const stateRef = useRef(state);
  stateRef.current = state;
  const tierRef = useRef(tier);
  tierRef.current = tier;
  const reduceRef = useRef(false);
  const flagsRef = useRef({ pageVisible: true, inView: true, idleTimedOut: false });
  const syncRef = useRef<() => void>(() => {});

  /**
   * 帧回调：pose 目标 → 弹簧积分 → setAttribute。
   * 结构与原型 frame() 逐条对应；icon 档裁剪点见各注释。
   */
  const frame = useMemo(() => {
    return (now: number, dt: number): void => {
      const R = runtimeRef.current;
      if (R === null) return;
      const S = R.springs;
      const reduce = reduceRef.current;
      const icon = tierRef.current === "icon";

      // 受控 state prop → 内部状态机迁移（celebrate 顺带起跳）
      const wanted = stateRef.current;
      if (wanted !== R.seenState) {
        R.seenState = wanted;
        R.stateAt = now;
        if (wanted === "celebrate") R.hopAt = now;
      }

      // reduced-motion：冻结时间相位 → poseTargets(·,0,0) = 静态标准姿态
      const ph = reduce ? 0 : (now - R.t0) / 1000;
      const dtS = reduce ? 0 : (now - R.stateAt) / 1000;
      const P = poseTargets(R.seenState, ph, dtS);

      // 眨眼：reduce 关闭；icon 保留普通单眨、裁掉二次眨眼花样
      if (!reduce && now >= R.blinkUntil) {
        queueBlink(R.blinkQueue, now, !icon);
        R.blinkUntil = now + rand(BLINK_INTERVAL_MS[0], BLINK_INTERVAL_MS[1]);
      }
      const blink = consumeBlink(R.blinkQueue, now);
      if (blink !== null) R.blinkVal = blink;
      else if (R.blinkQueue.length === 0) R.blinkVal = 1;

      // 扫视（icon 裁掉）
      if (!reduce && !icon && now >= R.saccadeUntil) {
        R.fx = rand(-1, 1);
        R.fy = rand(-0.8, 0.8);
        R.saccadeUntil = now + (Math.random() < 0.22 ? rand(90, 160) : rand(420, 1500));
      }

      // 耳抽动（full 独有 + 仅 idle + reduce 禁用）
      if (!reduce && !icon && now >= R.earTwitchUntil && R.seenState === "idle") {
        R.earTwitchUntil = now + rand(EAR_TWITCH_INTERVAL_MS[0], EAR_TWITCH_INTERVAL_MS[1]);
        queueEarTwitch(R.earQueue, now);
      }
      const ear = consumeEar(R.earQueue, now);
      if (ear !== null) {
        R.earTL = ear.vL;
        R.earTR = ear.vR;
      } else if (R.earQueue.length === 0) {
        R.earTL = 0;
        R.earTR = 0;
      }

      const lid = clamp(R.blinkVal * P.lid, 0.03, 1.3);
      const targets: Record<SpringName, number> = {
        bob: P.bob,
        spin: P.spin,
        sqx: P.sqx,
        sqy: P.sqy,
        headT: P.headT,
        earL: R.earTL,
        earR: R.earTR,
        lidL: lid,
        lidR: lid,
        gx: R.fx * 0.8 + P.gx,
        gy: R.fy * 0.8 + P.gy,
        pawL: P.pawL,
        pawR: P.pawR,
        tail: P.tail,
        mouth: P.mouth,
      };
      for (const name of SPRING_NAMES) {
        const spring = S[name];
        spring.t = targets[name];
        if (reduce || (icon && !ICON_SPRINGS.has(name))) snap(spring);
      }

      // 固定子步积分（不同帧率下轨迹一致）；icon 档只步进核心子集
      const sub = reduce ? 1 : Math.max(1, Math.ceil(dt / STEP_DT));
      const sdt = dt / sub;
      for (let i = 0; i < sub; i++) {
        if (reduce) break;
        for (const name of SPRING_NAMES) {
          if (icon && !ICON_SPRINGS.has(name)) continue;
          const [freq, damp] = SPRINGS[name];
          stepSpring(S[name], freq, damp, sdt);
        }
      }

      // hop（celebrate 起跳；reduce/icon 禁用——评审 P2 项）
      let hop = 0;
      if (!reduce && !icon && R.hopAt >= 0) {
        const offset = hopY(R.hopAt, now);
        if (offset === null) R.hopAt = -1;
        else hop = offset;
      }

      // ── DOM 写入（与原型 frame() 的 setAttribute 逐条对应） ──
      const set = (node: SVGGElement | null, attr: string, value: string): void => {
        if (node) node.setAttribute(attr, value);
      };
      const body = PIVOT.body;
      refs.root.current?.setAttribute(
        "transform",
        `translate(0 ${(S.bob.x + hop).toFixed(2)}) rotate(${S.spin.x.toFixed(2)} ${body.x} ${body.y}) translate(${body.x} ${body.y}) scale(${S.sqx.x.toFixed(4)} ${S.sqy.x.toFixed(4)}) translate(${-body.x} ${-body.y})`,
      );
      set(refs.tail.current, "transform", `rotate(${S.tail.x.toFixed(2)} ${PIVOT.tail.x} ${PIVOT.tail.y})`);
      set(refs.head.current, "transform", `rotate(${S.headT.x.toFixed(2)} ${PIVOT.head.x} ${PIVOT.head.y})`);
      const earLTransform = `rotate(${S.earL.x.toFixed(2)} ${PIVOT.earL.x} ${PIVOT.earL.y})`;
      const earRTransform = `rotate(${S.earR.x.toFixed(2)} ${PIVOT.earR.x} ${PIVOT.earR.y})`;
      set(refs.earLB.current, "transform", earLTransform);
      set(refs.earLF.current, "transform", earLTransform);
      set(refs.earRB.current, "transform", earRTransform);
      set(refs.earRF.current, "transform", earRTransform);
      const lidValue = clamp(S.lidL.x, 0.03, 1.3).toFixed(3);
      for (const [grp, inner, cx] of [
        [refs.eyeLGrp, refs.eyeLInner, EYE.bx],
        [refs.eyeRGrp, refs.eyeRInner, PIVOT.viewBox - EYE.bx],
      ] as const) {
        set(grp.current, "transform", `translate(${cx} ${EYE.by}) scale(1 ${lidValue}) translate(${-cx} ${-EYE.by})`);
        set(inner.current, "transform", `translate(${(S.gx.x * 3).toFixed(2)} ${(S.gy.x * 2.6).toFixed(2)})`);
      }
      set(refs.pawL.current, "transform", `translate(${PIVOT.paw.leftX} ${(PIVOT.paw.y + S.pawL.x).toFixed(2)})`);
      set(refs.pawR.current, "transform", `translate(${PIVOT.paw.rightX} ${(PIVOT.paw.y + S.pawR.x).toFixed(2)})`);
      set(
        refs.mouth.current,
        "transform",
        `translate(${PIVOT.mouth.x} ${PIVOT.mouth.y}) scale(1 ${S.mouth.x.toFixed(3)}) translate(${-PIVOT.mouth.x} ${-PIVOT.mouth.y})`,
      );

      // 静置超时退订（§6-3 条件三）：恢复靠 state 变更 effect 重订
      if (R.seenState === "idle" && now - R.stateAt > IDLE_UNSUBSCRIBE_MS) {
        flagsRef.current.idleTimedOut = true;
        syncRef.current();
      }
    };
    // refs 内的 RefObject 本体跨渲染稳定，帧回调只建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 订阅管理：三条件取反即退订；任一恢复即重订
  useEffect(() => {
    const sync = (): void => {
      const flags = flagsRef.current;
      const shouldRun = flags.pageVisible && flags.inView && !flags.idleTimedOut;
      if (shouldRun) addTick(frame);
      else removeTick(frame);
    };
    syncRef.current = sync;

    // prefers-reduced-motion（jsdom/老环境无 matchMedia 时视为不减弱）
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    const applyReduce = (): void => {
      reduceRef.current = media?.matches ?? false;
    };
    applyReduce();
    media?.addEventListener?.("change", applyReduce);

    const onVisibility = (): void => {
      flagsRef.current.pageVisible = !document.hidden;
      sync();
    };
    flagsRef.current.pageVisible = !document.hidden;
    document.addEventListener("visibilitychange", onVisibility);

    // 离屏退订（jsdom 无 IntersectionObserver 时视为始终可见）
    let observer: IntersectionObserver | null = null;
    const host = refs.svg.current;
    if (host && typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        flagsRef.current.inView = entries.some((entry) => entry.isIntersecting);
        sync();
      });
      observer.observe(host);
    }

    sync();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener?.("change", applyReduce);
      observer?.disconnect();
      removeTick(frame);
      syncRef.current = () => {};
    };
  }, [frame, refs]);

  // 状态切换 = 实例恢复活动：清 idle 超时并恢复订阅（§6-3 的"恢复时重订"）
  useEffect(() => {
    if (flagsRef.current.idleTimedOut) {
      flagsRef.current.idleTimedOut = false;
      syncRef.current();
    }
  }, [state]);
}
