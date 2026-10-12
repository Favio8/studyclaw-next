"use client";

import { Check, ListTodo } from "lucide-react";
import MarkdownView from "@/src/components/chat/MarkdownView";
import type { AgentProjectionView } from "@/src/types/api";

export default function PlanPanel({ steps }: { steps: AgentProjectionView["plan"]["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <section className="mt-2 border-t border-border-faint pt-2" data-plan-panel="">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><ListTodo size={12} aria-hidden />计划</div>
      <div className="space-y-0.5">
        {steps.slice(0, 8).map((step) => (
          <div key={step.id} className="flex items-start gap-1.5 text-text-faint">
            <Check size={11} className={step.status === "completed" ? "text-accent-pass" : step.status === "in_progress" ? "text-accent-focus" : "text-text-caption"} aria-hidden />
            <MarkdownView content={step.text} compact modelOutput />
          </div>
        ))}
      </div>
    </section>
  );
}
