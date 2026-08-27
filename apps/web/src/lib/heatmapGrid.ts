/**
 * 热力图网格构建（纯函数）：把后端的连续天数序列（旧→新）映射为
 * GitHub 风格的「列=周、行=星期几」网格。
 *
 * 旧实现按 `weekday = getDay()` 定行、`floor(index/7)` 机械切列，两者仅在
 * 数据首日恰好是周日时才对齐——其余情况下日期会在网格里散乱分布。
 * 这里改为日期驱动：第一格落在首日的真实星期位上，之后逐日推进。
 * @module heatmap-grid
 */

import type { HeatmapDay } from "@/src/types/api";

export interface HeatmapCell {
  date: string;
  day: HeatmapDay | null;
}

export interface HeatmapGridColumn {
  /** 该列首个数据日的月份标签（如 "6月"）；与上一列同月或无数据时为 null。 */
  monthLabel: string | null;
  /** 固定 7 行（周日 → 周六），前导/越界为 null。 */
  cells: Array<HeatmapCell | null>;
}

export interface HeatmapGrid {
  columns: HeatmapGridColumn[];
  /** 实际列数（含首列前导空位）。 */
  totalWeeks: number;
}

function toLocalDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function buildHeatmapGrid(days: ReadonlyArray<HeatmapDay>): HeatmapGrid {
  if (days.length === 0) return { columns: [], totalWeeks: 0 };

  const byDate = new Map(days.map(day => [day.date, day]));
  const start = new Date(`${days[0]!.date}T00:00:00`);
  const startWeekday = start.getDay();
  const totalCells = startWeekday + days.length;
  const totalWeeks = Math.ceil(totalCells / 7);
  const lastDataIndex = totalCells - 1;

  const columns: HeatmapGridColumn[] = [];
  const cursor = new Date(start);

  // 列月份标签（GitHub 语义）：新月份的 1 号落在哪一列，就在哪一列标注
  // 该月；首列若无月初边界，则标注首日所属月份。
  let firstDataMonthLabeled = false;

  for (let column = 0; column < totalWeeks; column += 1) {
    const cells: Array<HeatmapCell | null> = [];
    for (let row = 0; row < 7; row += 1) {
      const cellIndex = column * 7 + row;
      if (cellIndex < startWeekday || cellIndex >= totalCells) {
        cells.push(null);
        continue;
      }
      const date = toLocalDateKey(cursor);
      cells.push({ date, day: byDate.get(date) ?? null });
      cursor.setDate(cursor.getDate() + 1);
    }

    // 该列覆盖的数据日期区间（前后空位不属于任何月份标注）
    const rangeStartIndex = Math.max(startWeekday, column * 7);
    const rangeEndIndex = Math.min(lastDataIndex, column * 7 + 6);
    const rangeStart = new Date(start);
    rangeStart.setDate(start.getDate() + (rangeStartIndex - startWeekday));
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeStart.getDate() + (rangeEndIndex - rangeStartIndex));

    // 找区间内第一个「1 号」：命中则该列标注新月份
    let monthLabel: string | null = null;
    const probe = new Date(rangeStart);
    while (probe <= rangeEnd) {
      if (probe.getDate() === 1) {
        monthLabel = `${probe.getMonth() + 1}月`;
        break;
      }
      probe.setDate(probe.getDate() + 1);
    }
    if (monthLabel === null && column === 0) {
      monthLabel = `${rangeStart.getMonth() + 1}月`;
    }

    columns.push({ monthLabel, cells });
  }
  return { columns, totalWeeks };
}
