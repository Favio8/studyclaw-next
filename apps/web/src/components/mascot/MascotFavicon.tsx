"use client";

/**
 * 动态 favicon（P1-③，设计文档 §5.4）：
 *
 * 基础 icon 是 app/icon.svg 的静态剪影；本组件在客户端按派生状态用 canvas
 * 重绘 32×32 favicon 并覆盖 <link rel="icon">——alerting 红点、encourage 暗蓝、
 * celebrate 金色爪印点，其余状态维持静态剪影不重绘。
 *
 * 节流：只在「状态类」变化时重绘一次（非逐帧），canvas 离屏绘制 + toDataURL
 * 一次性替换 link，不产生任何动画循环。
 */

import { useEffect, useRef } from "react";
import { useMascotState } from "@/src/components/mascot/useMascotState";
import type { MascotState } from "@/src/components/mascot/types";

/** 状态 → 角标色（null = 不重绘，保持静态剪影）。 */
const BADGE_COLOR: Partial<Record<MascotState, string>> = {
  alerting: "#EC1313",
  encourage: "#0A1B52",
  celebrate: "#F59E0B",
};

function drawFavicon(badge: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return "";
  // 底：圆角品牌蓝方 + 双耳三角 + 墨蓝眼点（与 icon.svg 剪影同构，手工缩绘）
  ctx.fillStyle = "#4176E6";
  ctx.beginPath();
  ctx.roundRect(2, 6, 28, 24, 6);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(4, 10);
  ctx.lineTo(6, 1);
  ctx.lineTo(15, 7);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(28, 10);
  ctx.lineTo(26, 1);
  ctx.lineTo(17, 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#0A1B52";
  ctx.beginPath();
  ctx.ellipse(11, 18, 2.8, 3.8, 0, 0, Math.PI * 2);
  ctx.ellipse(21, 18, 2.8, 3.8, 0, 0, Math.PI * 2);
  ctx.fill();
  // 角标：右上圆点
  ctx.fillStyle = badge;
  ctx.beginPath();
  ctx.arc(26, 6, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  return canvas.toDataURL("image/png");
}

export default function MascotFavicon() {
  const state = useMascotState();
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    const badge = BADGE_COLOR[state];
    // 静态态：恢复默认剪影（只做一次）；带角标态：变化才重绘
    const target = badge ?? "default";
    if (appliedRef.current === target) return;
    appliedRef.current = target;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-mascot-favicon]");
    if (link === null) {
      link = document.createElement("link");
      link.rel = "icon";
      link.setAttribute("data-mascot-favicon", "");
      document.head.appendChild(link);
    }
    link.href = badge === undefined ? "/icon.svg" : drawFavicon(badge);
  }, [state]);

  return null;
}
