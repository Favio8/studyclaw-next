"use client";

import { Check, ListTodo } from "lucide-react";
import { Clawzy } from "@/src/components/mascot";
import type { AgentProjectionView } from "@/src/types/api";

export default function PlanPanel({ steps }: { steps: AgentProjectionView["plan"]["steps"] }) {
  if (steps.length === 0) {
    // F-8：同 TodoPanel——空计划也渲染占位，而非整块消失。
    return (
      <section className="mt-2 border-t border-border-faint pt-2" data-plan-panel="">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><ListTodo size={12} aria-hidden />计划</div>
        <div className="flex items-center gap-2">
          {/* P1 空态陪伴爪爪（24px icon 档） */}
          <Clawzy size={24} tier="icon" ariaLabel="爪爪" />
          <p className="text-[11px] text-text-caption">暂无学习计划；开始一段对话后会自动生成步骤。</p>
        </div>
      </section>
    );
  }
  return (
    <section className="mt-2 border-t border-border-faint pt-2" data-plan-panel="">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-text-muted"><ListTodo size={12} aria-hidden />计划</div>
      <div className="space-y-0.5">
        {steps.slice(0, 8).map((step) => (
          <div key={step.id} className="flex items-center gap-1.5 truncate text-[11px] text-text-faint">
            <Check size={11} className={step.status === "completed" ? "text-accent-pass" : step.status === "in_progress" ? "text-accent-focus" : "text-text-caption"} aria-hidden />
            <span className="truncate">{step.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
