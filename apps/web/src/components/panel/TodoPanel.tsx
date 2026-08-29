"use client";

import { Circle, Clock3 } from "lucide-react";
import { Clawzy } from "@/src/components/mascot";
import type { AgentProjectionView } from "@/src/types/api";

export default function TodoPanel({ items }: { items: AgentProjectionView["todos"] }) {
  if (items.length === 0) {
    // F-8：空状态可见——用户能区分"面板空"与"未渲染"，避免误判 agent 没在干活。
    return (
      <section className="mt-2 border-t border-border-faint pt-2" data-todo-panel="">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><Clock3 size={12} aria-hidden />待办</div>
        <div className="flex items-center gap-2">
          {/* P1 空态陪伴爪爪（24px icon 档） */}
          <Clawzy size={24} tier="icon" ariaLabel="爪爪" />
          <p className="text-[11px] text-text-caption">暂无待办；发送消息后由学习助手生成。</p>
        </div>
      </section>
    );
  }
  return (
    <section className="mt-2 border-t border-border-faint pt-2" data-todo-panel="">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><Clock3 size={12} aria-hidden />待办</div>
      <div className="space-y-0.5">
        {items.slice(0, 8).map((item) => (
          <div key={item.id} className="flex items-center gap-1.5 truncate text-[11px] text-text-faint">
            <Circle size={9} className={item.status === "completed" ? "fill-accent-pass text-accent-pass" : item.status === "in_progress" ? "fill-accent-focus/30 text-accent-focus" : "text-text-caption"} aria-hidden />
            <span className="truncate">{item.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
