/**
 * buildHeatmapGrid 回归（热力图排版修复）：
 * - 列=周、行=星期几，首格落在首日真实星期位（修复旧「每 7 个数据切一列」
 *   导致的日期散乱分布）；
 * - 月份标签按列首月份变化标注；
 * - 空序列安全。
 */

import { describe, expect, it } from "vitest";
import { buildHeatmapGrid } from "../src/lib/heatmapGrid";
import type { HeatmapDay } from "../src/types/api";

function day(date: string, level = 0): HeatmapDay {
  return { date, score: level, level, tasks: level, chatTurns: 0, weakSpotsCleared: 0 };
}

/** 2026-06-06 是周六（weekday=6），2026-06-07 是周日（weekday=0）。 */
describe("buildHeatmapGrid", () => {
  it("首列按首日星期位前导留空，数据沿真实星期行连续排布", () => {
    // 从周六开始的一周数据：周六、周日、周一……
    const grid = buildHeatmapGrid([
      day("2026-06-06"),
      day("2026-06-07", 1),
      day("2026-06-08", 2),
    ]);
    expect(grid.totalWeeks).toBe(2); // 周六起 3 天 → 首列 1 格 + 次列 2 格
    const firstColumn = grid.columns[0]!.cells;
    // 行 0~5（周日~周五）为前导空位，行 6（周六）是首日
    for (let row = 0; row < 6; row += 1) expect(firstColumn[row]).toBeNull();
    expect(firstColumn[6]).toMatchObject({ date: "2026-06-06", day: { level: 0 } });
    // 第二列从周日开始：06-07 在行 0
    expect(grid.columns[1]!.cells[0]).toMatchObject({ date: "2026-06-07", day: { level: 1 } });
    expect(grid.columns[1]!.cells[1]).toMatchObject({ date: "2026-06-08", day: { level: 2 } });
  });

  it("每周 7 格严格对齐：同一列内的日期星期相同", () => {
    const days = Array.from({ length: 14 }, (_unused, index) => {
      const date = new Date(Date.UTC(2026, 5, 6) + index * 86_400_000);
      return day(date.toISOString().slice(0, 10));
    });
    const grid = buildHeatmapGrid(days);
    expect(grid.totalWeeks).toBe(3); // 周六起 14 天 → 20 格 → 3 列
    // 不变式：同一「行」（星期位）跨列的所有日期，星期几完全一致
    for (let row = 0; row < 7; row += 1) {
      const weekdays = grid.columns
        .map(column => column.cells[row])
        .filter(cell => cell !== null)
        .map(cell => new Date(`${cell!.date}T00:00:00`).getDay());
      expect(new Set(weekdays).size).toBeLessThanOrEqual(1);
    }
  });

  it("月份标签在跨月列标注（6月 → 7月）", () => {
    // 2026-06-29（周一）~ 2026-07-02：跨月
    const grid = buildHeatmapGrid([
      day("2026-06-29"),
      day("2026-06-30"),
      day("2026-07-01", 1),
      day("2026-07-02"),
    ]);
    // GitHub 语义：7 月 1 日所在列标注「7月」（而非列首日所在的 6 月）
    const labels = grid.columns.map(column => column.monthLabel);
    expect(labels).toEqual(["7月"]);
  });

  it("空序列返回空网格", () => {
    expect(buildHeatmapGrid([])).toEqual({ columns: [], totalWeeks: 0 });
  });
});
