"use client";

import { Circle, Clock3 } from "lucide-react";
import MarkdownView from "@/src/components/chat/MarkdownView";
import type { AgentProjectionView } from "@/src/types/api";

export default function TodoPanel({ items }: { items: AgentProjectionView["todos"] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-2 border-t border-border-faint pt-2" data-todo-panel="">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><Clock3 size={12} aria-hidden />待办</div>
      <div className="space-y-0.5">
        {items.slice(0, 8).map((item) => (
          <div key={item.id} className="flex items-start gap-1.5 text-text-faint">
            <Circle size={9} className={item.status === "completed" ? "fill-accent-pass text-accent-pass" : item.status === "in_progress" ? "fill-accent-focus/30 text-accent-focus" : "text-text-caption"} aria-hidden />
            <MarkdownView content={item.text} compact modelOutput />
          </div>
        ))}
      </div>
    </section>
  );
}
