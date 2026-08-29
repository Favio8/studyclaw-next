import { describe, expect, it } from "vitest";
import { EYE, MIR, mir, PAW_TOES, PIVOT, SH } from "../../src/components/mascot/geometry";

/** path 里允许出现的指令与分隔符（几何表只用 M/C/L/Z）。 */
const PATH_ALLOWED = /^[MLCZmlcz0-9\s.,-]+$/;

function pairs(d: string): Array<[number, number]> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push([parseFloat(nums[i]), parseFloat(nums[i + 1])]);
  }
  return out;
}

describe("爪爪几何常量", () => {
  it("SH 表每条 path 非空、指令合法、坐标均为有限数且落在画布附近", () => {
    for (const [name, d] of Object.entries(SH)) {
      expect(d.length, name).toBeGreaterThan(0);
      expect(d.startsWith("M"), `${name} 以 M 开头`).toBe(true);
      expect(PATH_ALLOWED.test(d), `${name} 指令合法`).toBe(true);
      for (const [x, y] of pairs(d)) {
        expect(Number.isFinite(x), name).toBe(true);
        expect(Number.isFinite(y), name).toBe(true);
        expect(x, name).toBeGreaterThanOrEqual(-1);
        expect(x, name).toBeLessThanOrEqual(241);
        expect(y, name).toBeGreaterThanOrEqual(-1);
        expect(y, name).toBeLessThanOrEqual(241);
      }
    }
  });

  it("mir 镜像对合：mir(mir(d)) 数值还原（容差内），且首点 x 镜像为 240-x", () => {
    for (const d of Object.values(SH)) {
      const original = pairs(d);
      const roundTrip = pairs(mir(mir(d)));
      // 240-x 引入浮点尾差（原型一致），按数值容差断言对合性
      expect(roundTrip).toHaveLength(original.length);
      original.forEach(([x, y], i) => {
        expect(roundTrip[i][0]).toBeCloseTo(x, 6);
        expect(roundTrip[i][1]).toBeCloseTo(y, 6);
      });
      const [first] = original;
      const [mirrored] = pairs(mir(d));
      expect(mirrored[0]).toBeCloseTo(240 - first[0], 6);
      expect(mirrored[1]).toBeCloseTo(first[1], 6);
    }
  });

  it("预计算镜像表与 mir() 一致", () => {
    expect(MIR.earLOut).toBe(mir(SH.earLOut));
    expect(MIR.earLLine).toBe(mir(SH.earLLine));
    expect(MIR.earIn).toBe(mir(SH.earIn));
    expect(MIR.foot).toBe(mir(SH.foot));
  });

  it("EYE / PIVOT 常量自洽（双眼对称、耳根对称、爪位成对）", () => {
    expect(EYE.bx).toBeLessThan(120);
    expect(PIVOT.earR.x).toBe(240 - PIVOT.earL.x);
    expect(PIVOT.earR.y).toBe(PIVOT.earL.y);
    expect(PIVOT.viewBox).toBe(240);
    expect(PAW_TOES).toHaveLength(3);
  });
});
