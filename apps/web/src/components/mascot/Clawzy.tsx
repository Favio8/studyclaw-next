"use client";

/**
 * 爪爪组件：确定性 JSX 静态 SVG 骨架 + 引擎挂载（§6-5 SSR 安全）。
 *
 * - 首帧输出 = 全部弹簧初值下的静置姿态（与原型 buildCat 的 DOM 结构逐层对应，
 *   zIndex 顺序：尾 → 身 → 双足 → 头（耳背层 → 头填充 → 描线 → [full: 耳前层/
 *   吻部/鼻/嘴] → 双眼）→ 双前爪）；
 * - 之后引擎每帧只 setAttribute transform，React 不参与帧路径（§6-1）；
 * - tier=icon（<48px 缺省）：不渲染内耳三角/眼高光/嘴线（评审 16px 兜底档）。
 *
 * 颜色：身体 = var(--color-accent-focus) 品牌蓝派生（方案 §2.2-2）；
 * 描线/瞳孔固定墨蓝（实心眼+白高光，原「镂空眼」决策已随换猫作废）。
 */

import { useMemo, useRef, type CSSProperties } from "react";
import { EYE, MIR, PAW_TOES, PIVOT, SH } from "./geometry";
import { useMascotEngine, type MascotPartRefs } from "./useMascotEngine";
import { useMascotState } from "./useMascotState";
import type { ClawzyProps, MascotState, MascotTier } from "./types";

/** 描线/瞳孔墨蓝（原型 --ink/--pupil 同值）。 */
const INK = "#0A1B52";
/** 浅色部件（内耳/吻部/爪垫，原型 --pale）。 */
const PALE = "#CCDDFF";
/** 主描线宽（原型 --sw）。 */
const STROKE_WIDTH = 4;

/** 缺省 tier：≥48px 完整脸，其余 icon 简化档（方案 §4.3）。 */
export function resolveTier(size: number, tier?: MascotTier): MascotTier {
  return tier ?? (size >= 48 ? "full" : "icon");
}

interface CatSvgProps {
  size: number;
  state: MascotState;
  tier: MascotTier;
  ariaLabel: string;
  svgRef: React.RefObject<SVGSVGElement | null>;
  partRefs: MascotPartRefs;
}

function CatSvg({ size, state, tier, ariaLabel, svgRef, partRefs }: CatSvgProps) {
  const full = tier === "full";
  const style = {
    display: "block",
    overflow: "visible",
    // 身体蓝 = 品牌蓝 token 派生（§2.2-2）：不再出现第二种"品牌蓝"；
    // 深浅阶如后续需要，用 color-mix(var(--color-accent-focus), …) 生成，不新增色板
    "--mascot-body": "var(--color-accent-focus)",
  } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${PIVOT.viewBox} ${PIVOT.viewBox}`}
      width={size}
      height={size}
      role="img"
      aria-label={ariaLabel}
      style={style}
      data-mascot-state={state}
      data-mascot-tier={tier}
    >
      <g ref={partRefs.root}>
        <g ref={partRefs.tail}>
          <path d={SH.tail} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" />
        </g>
        <path d={SH.body} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" />
        <path d={SH.foot} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" />
        <path d={MIR.foot} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" />

        <g ref={partRefs.head}>
          {/* 双耳背层夹住头部：耳形填色 + 外缘描线（与头线在耳根角点相接） */}
          <g ref={partRefs.earLB}>
            <path d={SH.earLOut} fill="var(--mascot-body)" />
            <path d={SH.earLLine} fill="none" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" />
          </g>
          <g ref={partRefs.earRB}>
            <path d={MIR.earLOut} fill="var(--mascot-body)" />
            <path d={MIR.earLLine} fill="none" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" />
          </g>
          <path d={SH.headFill} fill="var(--mascot-body)" />
          <path d={SH.headSides} fill="none" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" />
          <path d={SH.headSag} fill="none" stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" />
          {full ? (
            <>
              <g ref={partRefs.earLF}>
                <path d={SH.earIn} fill={PALE} />
              </g>
              <g ref={partRefs.earRF}>
                <path d={MIR.earIn} fill={PALE} />
              </g>
              <ellipse cx={120} cy={120.5} rx={26} ry={19.3} fill={PALE} />
              <path d={SH.nose} fill={PALE} stroke={INK} strokeWidth={2.8} strokeLinejoin="round" />
              <g ref={partRefs.mouth} fill="none" stroke={INK} strokeWidth={2.8} strokeLinecap="round">
                <path d={SH.mouthPhil} />
                <path d={SH.mouthL} />
                <path d={SH.mouthR} />
              </g>
            </>
          ) : null}

          {/* 眼：外层组眨眼 scaleY，内层组视线 translate，瞳孔实心墨蓝 + 白高光 */}
          <g ref={partRefs.eyeLGrp}>
            <g ref={partRefs.eyeLInner}>
              <ellipse cx={EYE.bx} cy={EYE.by} rx={EYE.rx} ry={EYE.ry} fill={INK} />
              {full ? <circle cx={EYE.bx + 2.4} cy={EYE.by - 8.3} r={3.7} fill="#fff" opacity={0.95} /> : null}
            </g>
          </g>
          <g ref={partRefs.eyeRGrp}>
            <g ref={partRefs.eyeRInner}>
              <ellipse cx={PIVOT.viewBox - EYE.bx} cy={EYE.by} rx={EYE.rx} ry={EYE.ry} fill={INK} />
              {full ? <circle cx={PIVOT.viewBox - EYE.bx - 2.4} cy={EYE.by - 8.3} r={3.7} fill="#fff" opacity={0.95} /> : null}
            </g>
          </g>
        </g>

        {/* 前爪：定位 transform 交给引擎逐帧改写，首帧 translate(x 166) = 静置 */}
        <g ref={partRefs.pawL} transform={`translate(${PIVOT.paw.leftX} ${PIVOT.paw.y})`}>
          <circle cx={0} cy={0} r={23.6} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} />
          <g transform="translate(-90 -166)">
            <path d={SH.pad} fill={PALE} />
            {PAW_TOES.map(({ dx, dy }) => (
              <circle key={`${dx}:${dy}`} cx={90 + dx} cy={166 + dy} r={3.6} fill={PALE} />
            ))}
          </g>
        </g>
        <g ref={partRefs.pawR} transform={`translate(${PIVOT.paw.rightX} ${PIVOT.paw.y})`}>
          <circle cx={0} cy={0} r={23.6} fill="var(--mascot-body)" stroke={INK} strokeWidth={STROKE_WIDTH} />
          <g transform="translate(-90 -166)">
            <path d={SH.pad} fill={PALE} />
            {PAW_TOES.map(({ dx, dy }) => (
              <circle key={`${dx}:${dy}`} cx={90 + dx} cy={166 + dy} r={3.6} fill={PALE} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}

/** 实际渲染 + 引擎挂载（hooks 全部无条件调用）。 */
function ClawzyView({ state, size, tier, ariaLabel }: { state: MascotState; size: number; tier?: MascotTier; ariaLabel?: string }) {
  const resolvedTier = resolveTier(size, tier);
  const svgRef = useRef<SVGSVGElement>(null);
  const root = useRef<SVGGElement>(null);
  const tail = useRef<SVGGElement>(null);
  const head = useRef<SVGGElement>(null);
  const earLB = useRef<SVGGElement>(null);
  const earRB = useRef<SVGGElement>(null);
  const earLF = useRef<SVGGElement>(null);
  const earRF = useRef<SVGGElement>(null);
  const eyeLGrp = useRef<SVGGElement>(null);
  const eyeLInner = useRef<SVGGElement>(null);
  const eyeRGrp = useRef<SVGGElement>(null);
  const eyeRInner = useRef<SVGGElement>(null);
  const pawL = useRef<SVGGElement>(null);
  const pawR = useRef<SVGGElement>(null);
  const mouth = useRef<SVGGElement>(null);
  // 容器对象必须引用稳定：useMascotEngine 的订阅 effect 依赖 [frame, refs]，
  // 每次渲染新建容器会逐渲染重挂 IntersectionObserver/rAF/visibilitychange
  // 订阅——流式回复期间 Clawzy 图标随帧重渲染，纯白烧订阅。RefObject 本体
  // 逐渲染稳定，作为依赖即可。
  const partRefs = useMemo<MascotPartRefs>(() => ({
    svg: svgRef,
    root,
    tail,
    head,
    earLB,
    earRB,
    earLF,
    earRF,
    eyeLGrp,
    eyeLInner,
    eyeRGrp,
    eyeRInner,
    pawL,
    pawR,
    mouth,
  }), [svgRef, root, tail, head, earLB, earRB, earLF, earRF, eyeLGrp, eyeLInner, eyeRGrp, eyeRInner, pawL, pawR, mouth]);
  useMascotEngine(partRefs, state, resolvedTier);
  return (
    <CatSvg
      size={size}
      state={state}
      tier={resolvedTier}
      ariaLabel={ariaLabel ?? `爪爪：${state}`}
      svgRef={svgRef}
      partRefs={partRefs}
    />
  );
}

/** 自动派生档：未受控时从全局 store 读状态（hero/ pill 等场景）。 */
function ClawzyAuto(props: Omit<ClawzyProps, "state">) {
  const state = useMascotState();
  return <ClawzyView {...props} state={state} />;
}

/**
 * <Clawzy size={20} tier="icon" state?={MascotState} />
 * state 缺省时走 useMascotState() 自动派生（受控与自动分体，hook 规则安全）。
 */
export default function Clawzy(props: ClawzyProps) {
  const { state, ...rest } = props;
  if (state !== undefined) return <ClawzyView {...rest} state={state} />;
  return <ClawzyAuto {...rest} />;
}
