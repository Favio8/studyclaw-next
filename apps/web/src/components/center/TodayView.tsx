"use client";

/**
 * M4「今天」落地视图——**只回答一个问题：现在该做什么？**
 *
 * 刻意的克制：首屏只有一个大数字和一个主按钮，其余全部是可折叠的次级项。
 * 这不是偷懒，而是产品判断——「今天」页的价值在于**替用户消除决策**；一旦
 * 堆满信息，它就退化成又一个需要解读的仪表盘，反而增加了决策负担。
 *
 * 主按钮的默认动作：有到期卡 → 去复习；没有到期但有刚划的重点 → 回顾原文。
 */

import { useState, useSyncExternalStore } from "react";
import { BookMarked, ChevronDown, RotateCcw } from "lucide-react";
import { useAppStore } from "@/src/store/useAppStore";
import { quizLoad } from "@/src/lib/quizFlow";
import { panelSurfaceClass } from "@/src/components/panel/PanelPrimitives";

type Action = "review" | "reading";

/**
 * 默认落地页从「对话」改成「今天」会改变老用户的习惯，所以只在**首次**出现时
 * 给一次可跳过的说明，之后永不再来打扰（localStorage 记位）。
 */
const EXPLAINED_KEY = "studyclaw.today.explained.v1";

function subscribeExplanation(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function explainedSnapshot(): boolean {
  try { return window.localStorage.getItem(EXPLAINED_KEY) === "1"; } catch { return true; }
}

const explainedServerSnapshot = () => true;

function useExplainedOnce(): readonly [boolean, () => void] {
  const persisted = useSyncExternalStore(subscribeExplanation, explainedSnapshot, explainedServerSnapshot);
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(EXPLAINED_KEY, "1");
    } catch {
      // 写不进去只影响"下次还会看到"，不影响本次使用。
    }
  };
  return [persisted || dismissed, dismiss] as const;
}

function pickAction(dueCount: number, recentHighlights: number): Action | null {
  if (dueCount > 0) return "review";
  // 没有到期卡时，只有在确实有刚划的重点时才引导回顾——空状态不做无意义引导。
  return recentHighlights > 0 ? "reading" : null;
}

export default function TodayView() {
  const digest = useAppStore((s) => s.digest);
  const heatmap = useAppStore((s) => s.heatmap);
  const setCenterView = useAppStore((s) => s.setCenterView);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);
  const [showMore, setShowMore] = useState(false);
  const [explained, dismissExplained] = useExplainedOnce();

  const dueCount = digest?.dueCount ?? 0;
  const recentHighlights = digest?.recentHighlights ?? 0;
  const action = pickAction(dueCount, recentHighlights);

  function start() {
    if (action === "review") {
      // 必须走与活动切换完全同款的三步（切活动 → 聚焦右栏 → 装载复习流）。
      // 早期版本只做了前两步，主按钮点了却是一片空白——quizFlow 的活跃流要显式
      // quizLoad 才会去取题，光切视图不会触发。
      setCenterView("chat");
      setActiveTab("quiz");
      setRightPanelCollapsed(false);
      void quizLoad("review");
      return;
    }
    setCenterView("reading");
  }

  // 薄弱：还没测过、但已经有阅读接触的概念——最值得先验一验的那批。
  const untested = (digest?.concepts ?? [])
    .filter((concept) => concept.evals === 0 && concept.exposure > 0)
    .slice(0, 3);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-8" data-focus-zone="center">
      <h1 className="text-[13px] font-medium tracking-wide text-text-faint">今天</h1>

      {!explained ? (
        <div className={`mx-auto mt-4 max-w-md ${panelSurfaceClass} p-3`}>
          <p className="text-[12px] leading-5 text-text-muted">
            首屏换成了「今天」：只回答一个问题——现在该做什么。原来的对话在左边的活动栏，随时切回去。
          </p>
          <button
            type="button"
            onClick={dismissExplained}
            className="mt-2 rounded-md border border-border-line px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            知道了
          </button>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col items-center text-center">
        {action === null ? (
          <>
            <p className="text-[15px] leading-7 text-text-secondary">
              {recentHighlights > 0 ? "今天没有到期的复习。" : "今天没有到期的复习，也没有待消化的重点。"}
            </p>
            <p className="mt-1 text-[12px] text-text-faint">随时可以读资料、划重点，或新建一次对话。</p>
          </>
        ) : (
          <>
            {/* 主角数字必须与当前动作一致：没有到期卡却显示「0 张卡片待复习」
                是纯粹的噪声，会让人以为页面坏了。 */}
            <p className="text-[56px] font-semibold leading-none tabular-nums text-text-primary">
              {action === "review" ? dueCount : recentHighlights}
            </p>
            <p className="mt-2 text-[13px] text-text-muted">
              {action === "review" ? "张卡片待复习" : "条重点待回顾"}
            </p>
            <button
              type="button"
              onClick={start}
              className="mt-6 inline-flex min-h-10 items-center gap-2 rounded-md bg-accent-focus px-6 text-[13px] font-medium text-bg-panel transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus"
            >
              {action === "review" ? <RotateCcw size={15} strokeWidth={1.9} aria-hidden /> : <BookMarked size={15} strokeWidth={1.9} aria-hidden />}
              开始今天
            </button>
          </>
        )}
      </div>

      <div className="mt-8 flex flex-col items-center gap-1 text-[12px] text-text-faint">
        连续学习 {heatmap?.streak.current ?? 0} 天
      </div>

      {(untested.length > 0 || recentHighlights > 0) && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowMore((value) => !value)}
            aria-expanded={showMore}
            className="mx-auto flex items-center gap-1 text-[12px] text-text-faint transition-colors hover:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
          >
            <ChevronDown size={13} strokeWidth={1.8} className={showMore ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden />
            {showMore ? "收起" : "更多"}
          </button>
          {showMore ? (
            <ul className={`mx-auto mt-3 max-w-md space-y-1.5 ${panelSurfaceClass} p-3 text-[12px] leading-5 text-text-muted`}>
              {recentHighlights > 0 ? <li>近 24 小时划了 {recentHighlights} 条重点</li> : null}
              {untested.map((concept) => (
                <li key={concept.id} className="truncate">
                  「{concept.name}」有 {concept.exposure} 条划线，还没测过
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
