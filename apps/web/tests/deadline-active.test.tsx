import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeadlineActive } from "../src/hooks/useDeadlineActive";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

describe("截止时间订阅", () => {
  it("到期自动刷新，无需其它数据或组件更新", () => {
    const { result, unmount } = renderHook(() => useDeadlineActive(1_001_000));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("新的截止时间替换旧订阅，旧定时器不能提前使其过期", () => {
    const { result, rerender } = renderHook(({ deadline }) => useDeadlineActive(deadline), { initialProps: { deadline: 1_001_000 } });
    rerender({ deadline: 1_002_000 });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it("远期截止时间不能因 timer 溢出提前过期", () => {
    const duration = 2 ** 31 + 1000;
    const { result } = renderHook(() => useDeadlineActive(1_000_000 + duration));
    act(() => vi.advanceTimersByTime(2 ** 31 - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1001));
    expect(result.current).toBe(false);
  });

  it.each([null, NaN, Infinity, 999_000])("无效或已过期的截止时间 %s 不留下定时器", (deadline) => {
    const { result } = renderHook(() => useDeadlineActive(deadline));
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
