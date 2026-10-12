/**
 * 「今天」名言卡片的数据层：同一天稳定取同一句、换一句按顺序轮换、语录非空。
 */

import { describe, expect, it } from "vitest";
import { QUOTES, localDayKey, nextQuoteIndex, quoteIndexForDay } from "../src/lib/quotes";

describe("quotes", () => {
  it("同一天总是同一句（稳定），不同天可以不同", () => {
    const a = quoteIndexForDay("2026-10-12", QUOTES.length);
    const b = quoteIndexForDay("2026-10-12", QUOTES.length);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(QUOTES.length);
    // 连续多天不应退化成同一句（哈希分布基本可用）。
    const week = Array.from({ length: 7 }, (_v, index) => quoteIndexForDay(`2026-10-${12 + index}`, QUOTES.length));
    expect(new Set(week).size).toBeGreaterThan(1);
  });

  it("换一句按顺序轮换并在末尾回到开头", () => {
    expect(nextQuoteIndex(0, 3)).toBe(1);
    expect(nextQuoteIndex(2, 3)).toBe(0);
    expect(nextQuoteIndex(0, 0)).toBe(0);
    expect(quoteIndexForDay("2026-10-12", 0)).toBe(0);
  });

  it("本地日期键为 YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 9, 12))).toBe("2026-10-12");
  });

  it("每条语录都有正文与出处", () => {
    expect(QUOTES.length).toBeGreaterThanOrEqual(10);
    for (const quote of QUOTES) {
      expect(quote.text.trim().length).toBeGreaterThan(4);
      expect(quote.author.trim().length).toBeGreaterThan(0);
    }
  });
});
