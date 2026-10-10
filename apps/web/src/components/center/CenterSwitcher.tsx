"use client";

/**
 * 中栏一级「学习活动」切换：对话 / 测验 / 复习 / 阅读。
 *
 * 语义（PRD 需求二，选项 B：学习活动 × 对话风格拆两个维度）：
 * - 对话/阅读切换中栏视图（centerView）；
 * - 测验/复习的数据面板在右栏（QuizTab），点击即聚焦右栏并装载对应模式——
 *   quizFlow 的活跃评测流句柄是模块级单例，中栏不再挂第二个 QuizTab 实例
 *   互相中止；双入口同数据源，主从关系：一级入口=去活动，右栏 Tab=活动中看数据。
 * - 对话风格（苏格拉底/冲刺/费曼/排错）是对话活动内的第二维：右置分段控件
 *   一步切换。放在独占一行的活动栏而非输入框 footer——后者行内空间不足，
 *   CJK 无词边界会把四按钮折断成两行（历史提交已实测踩坑）。
 */

import { BookOpen, ListChecks, MessageSquare, RotateCcw } from "lucide-react";
import { MODES, MODE_DESCRIPTIONS } from "@/src/lib/modes";
import { quizLoad } from "@/src/lib/quizFlow";
import { useAppStore } from "@/src/store/useAppStore";
import type { CenterView } from "@/src/store/useAppStore";

const ACTIVITIES: Array<{ value: CenterView; label: string; icon: typeof BookOpen }> = [
  { value: "chat", label: "对话", icon: MessageSquare },
  { value: "quiz", label: "测验", icon: ListChecks },
  { value: "review", label: "复习", icon: RotateCcw },
  { value: "reading", label: "阅读", icon: BookOpen },
];

export default function CenterSwitcher() {
  const centerView = useAppStore((s) => s.centerView);
  const setCenterView = useAppStore((s) => s.setCenterView);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const flashModeBanner = useAppStore((s) => s.flashModeBanner);

  function selectActivity(view: CenterView) {
    setCenterView(view);
    if (view === "quiz" || view === "review") {
      // 测验/复习：聚焦右栏面板并装载（新题 / 到期复习）。
      setActiveTab("quiz");
      setRightPanelCollapsed(false);
      void quizLoad(view === "review" ? "review" : "new");
    }
  }

  function chooseMode(next: (typeof MODES)[number]) {
    setMode(next.value);
    flashModeBanner(`已切换 · ${next.label}`);
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-line px-3">
      <div role="group" aria-label="学习活动" className="inline-flex shrink-0 rounded-lg bg-bg-card p-0.5">
        {ACTIVITIES.map(({ value, label, icon: Icon }) => {
          const active = value === centerView;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              title={value === "reading" ? "辅助阅读（划线 · 翻译 · 解释）" : undefined}
              onClick={() => selectActivity(value)}
              className={`flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
                active
                  ? "bg-bg-panel text-text-primary shadow-[0_1px_2px_rgba(15,17,21,0.08)]"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              <Icon size={13} strokeWidth={1.8} aria-hidden />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {centerView === "chat" ? (
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-text-faint" title={MODE_DESCRIPTIONS[mode]}>
            对话风格 · {MODE_DESCRIPTIONS[mode]}
          </span>
          <div role="group" aria-label="对话风格" className="inline-flex shrink-0 rounded-lg bg-bg-card p-0.5">
            {MODES.map((item) => {
              const active = item.value === mode;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={active}
                  title={`${item.label} · ${MODE_DESCRIPTIONS[item.value]}`}
                  onClick={() => chooseMode(item)}
                  className={`flex h-7 items-center rounded-md px-2 text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
                    active
                      ? "bg-bg-panel text-text-primary shadow-[0_1px_2px_rgba(15,17,21,0.08)]"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </>
      ) : centerView === "reading" ? (
        <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-text-faint">资料精读 · 划线/翻译/解释/笔记</span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-text-faint">在右栏作答与批改 · 结果驱动 SM-2 复习排期</span>
      )}
    </div>
  );
}
