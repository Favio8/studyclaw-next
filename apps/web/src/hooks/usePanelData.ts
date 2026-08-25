"use client";

/**
 * 右栏面板数据装载（T3.2 + T3.4）：随激活项目全量刷新（§4.4，骨架屏）。
 * 薄封装：实际装载逻辑在 lib/panelData.refreshPanelData（store action 亦复用）。
 */

import { useEffect } from "react";
import { refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";

export function usePanelData() {
  const activeCourseId = useAppStore((s) => s.activeCourseId);

  useEffect(() => {
    void refreshPanelData();
  }, [activeCourseId]);

  return { refresh: refreshPanelData };
}