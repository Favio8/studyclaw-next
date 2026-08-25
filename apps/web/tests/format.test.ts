import { describe, expect, it } from "vitest";
import { formatMessageTime, relativeTime, dateOnly } from "../src/lib/format";

describe("format utils", () => {
  it("formats message clock as local HH:MM", () => {
    const iso = new Date(2026, 7, 20, 14, 5).toISOString();
    const time = formatMessageTime(iso);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("returns empty for invalid dates", () => {
    expect(formatMessageTime(null)).toBe("");
    expect(relativeTime("not-a-date")).toBe("");
    expect(dateOnly(null)).toBe("");
  });
});
