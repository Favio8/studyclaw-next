import { describe, expect, it } from "vitest";
import { clamp, mkSpring, snap, stepSpring, STEP_DT } from "../../src/components/mascot/spring";

/** 在目标值附近以固定步长推进 s 秒，返回末值与速度。 */
function settle(from: number, target: number, freq: number, damp: number, seconds: number) {
  const s = mkSpring(from);
  s.t = target;
  const steps = Math.round(seconds / STEP_DT);
  for (let i = 0; i < steps; i += 1) stepSpring(s, freq, damp, STEP_DT);
  return s;
}

describe("弹簧内核", () => {
  it("向目标值收敛（欠阻尼参数下的稳态误差可忽略）", () => {
    const s = settle(0, 10, 4, 0.8, 5);
    expect(Math.abs(s.x - 10)).toBeLessThan(1e-3);
    expect(Math.abs(s.v)).toBeLessThan(1e-2);
  });

  it("固定步长下能量不发散（多档步长、长时仿真保持有限且收敛）", () => {
    for (const dt of [1 / 120, 1 / 60, 1 / 30]) {
      const s = mkSpring(0);
      s.t = 42;
      let maxOvershoot = 0;
      const steps = Math.round(120 / dt); // 仿真 120 秒
      for (let i = 0; i < steps; i += 1) {
        stepSpring(s, 4, 0.8, dt);
        expect(Number.isFinite(s.x)).toBe(true);
        expect(Number.isFinite(s.v)).toBe(true);
        maxOvershoot = Math.max(maxOvershoot, Math.abs(s.x - 42));
      }
      // 阻尼系统：超调不得放大初始位移；终态收敛
      expect(maxOvershoot).toBeLessThanOrEqual(42 * 1.2);
      expect(Math.abs(s.x - 42)).toBeLessThan(1e-3);
    }
  });

  it("NaN/Infinity 输入兜底归位到目标", () => {
    const nan = mkSpring(5);
    nan.x = NaN;
    stepSpring(nan, 4, 0.8, STEP_DT);
    expect(nan.x).toBe(5);
    expect(nan.v).toBe(0);

    const inf = mkSpring(5);
    inf.t = 8;
    inf.v = Infinity;
    stepSpring(inf, 4, 0.8, STEP_DT);
    expect(inf.x).toBe(8);
    expect(inf.v).toBe(0);
  });

  it("snap 硬赋值：x=t、v=0（reduced-motion 降级路径）", () => {
    const s = mkSpring(0);
    s.t = 7;
    s.v = 3;
    snap(s);
    expect(s.x).toBe(7);
    expect(s.v).toBe(0);
  });

  it("clamp 边界与 STEP_DT 常量", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-3, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(STEP_DT).toBeCloseTo(1 / 120, 12);
  });
});
