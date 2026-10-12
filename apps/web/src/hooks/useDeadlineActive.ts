"use client";

import { useCallback, useSyncExternalStore } from "react";

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const serverSnapshot = () => false;

/** Subscribe to a deadline instead of reading the clock during component render. */
export function useDeadlineActive(deadline: number | null): boolean {
  const getSnapshot = useCallback(() => deadline !== null && Number.isFinite(deadline)
    && Date.now() < deadline, [deadline]);
  const subscribe = useCallback((notify: () => void) => {
    if (deadline === null || !Number.isFinite(deadline)) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { notify(); return; }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [deadline]);
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
