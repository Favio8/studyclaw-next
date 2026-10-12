"use client";

/**
 * 「今天」落地视图——回答**一件事**：现在该做什么？
 *
 * 设计取向（"案头的一张纸"，不是卡片架）：
 * - 整页铺满中栏，用**空气与细线**分隔区域，不给每一节套卡盒；
 * - 名言是唯一的陈列级元素（不加框），下方细线撑到右缘；
 * - 全页只有**一个实心按钮**（当前主行动），其余动作一律是文字链接；
 * - 边栏是"页边注"：小字 + 账目式 `dl`，放上下文（节奏 / 上次 / 资料 / 概览），
 *   与主区的动作形成一条竖直细线的语义分隔。
 *
 * 与右栏分工：完整掌握度表 / 热力图 / 题卡统计仍在右栏，这里只放**可执行**的
 * 下一步与一屏可读的上下文。
 */

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/src/store/useAppStore";
import { api } from "@/src/lib/api";
import { quizLoad } from "@/src/lib/quizFlow";
import { loadConceptCardStatus, startConceptFill } from "@/src/lib/conceptFillFlow";
import { openMaterialsDialog } from "@/src/lib/materialsDialog";
import { useSessionActions } from "@/src/hooks/useSessionActions";
import { pct, relativeTime } from "@/src/lib/format";
import { localDayKey } from "@/src/lib/quotes";
import OnboardingGuide from "@/src/components/center/OnboardingGuide";
import QuoteCard from "@/src/components/center/QuoteCard";

/** 「该练的概念」最多展示条数（到期 → 薄弱 → 未测）。 */
const FOCUS_LIMIT = 10;
const WEAK_THRESHOLD = 0.6;

/** 文字型动作（全页只有主行动是实心按钮，其余保持低视觉重量）。 */
const linkClass = "shrink-0 rounded text-[13px] text-accent-focus transition-colors hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus";

export default function TodayView() {
  const courseId = useAppStore((s) => s.activeCourseId);
  const digest = useAppStore((s) => s.digest);
  const progress = useAppStore((s) => s.progress);
  const heatmap = useAppStore((s) => s.heatmap);
  const cardStatus = useAppStore((s) => s.conceptCardStatus);
  const courseSessions = useAppStore((s) => s.courseSessions);
  const sessions = useAppStore((s) => s.sessions);
  const setCenterView = useAppStore((s) => s.setCenterView);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);
  const setFocusConcept = useAppStore((s) => s.setFocusConcept);
  const { selectSession, createSession } = useSessionActions();
  const [materials, setMaterials] = useState<{ key: string; count: number } | null>(null);

  // 概念补题入口的覆盖统计由右栏组件加载；「今天」不在右栏，这里补一次只读查询。
  useEffect(() => {
    if (courseId !== null) void loadConceptCardStatus();
  }, [courseId]);

  // 「资料」行：课程资料数（本地目录扫描，只读）。切课时旧结果不落地。
  useEffect(() => {
    if (courseId === null) return;
    let alive = true;
    void api.courseFiles(courseId)
      .then((payload) => { if (alive) setMaterials({ key: courseId, count: payload.files.filter((file) => file.supported).length }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [courseId]);

  const dueCount = digest?.dueCount ?? 0;
  const recentHighlights = digest?.recentHighlights ?? 0;
  const today = localDayKey();
  const materialCount = materials !== null && materials.key === courseId ? materials.count : null;

  function startReview(): void {
    setCenterView("chat");
    setActiveTab("quiz");
    setRightPanelCollapsed(false);
    void quizLoad("review");
  }

  /** 只练某个概念：切到题卡并带上 conceptId（RPC 已支持）。 */
  function practiceConcept(conceptId: string): void {
    setFocusConcept(conceptId);
    setCenterView("chat");
    setActiveTab("quiz");
    setRightPanelCollapsed(false);
    void quizLoad("new", false, conceptId);
  }

  function practiceAnything(): void {
    setCenterView("chat");
    setActiveTab("quiz");
    setRightPanelCollapsed(false);
    void quizLoad("new");
  }

  function fillCards(): void {
    setActiveTab("progress");
    setRightPanelCollapsed(false);
    void startConceptFill();
  }

  const concepts = digest?.concepts ?? [];
  const untested = concepts.filter((concept) => concept.evals === 0 && concept.exposure > 0);

  // 今天要做的事：每条都可执行；没有的项直接不渲染。
  const todo: Array<{ id: string; text: string; action: string; run: () => void }> = [];
  if (cardStatus !== null && cardStatus.modelReady && cardStatus.conceptOrigin === "semantic" && cardStatus.missingConcepts > 0) {
    todo.push({ id: "cards", text: `还有 ${cardStatus.missingConcepts} 个概念没有题卡`, action: "补齐题卡", run: fillCards });
  }
  if (untested.length > 0) {
    todo.push({ id: "practice", text: `「${untested[0]!.name}」等 ${untested.length} 个概念有划线但还没测过`, action: "去练习", run: () => practiceConcept(untested[0]!.id) });
  }
  if (recentHighlights > 0 && dueCount === 0) {
    todo.push({ id: "highlights", text: `近 24 小时划了 ${recentHighlights} 条重点`, action: "回顾原文", run: () => setCenterView("reading") });
  }

  // 该练的概念：到期（应付）→ 薄弱（该补）→ 未测（该开始），去重后取前 N 条。
  const dueConcepts = concepts
    .filter((concept) => concept.nextReviewAt !== null && concept.nextReviewAt <= today)
    .sort((a, b) => String(a.nextReviewAt).localeCompare(String(b.nextReviewAt)));
  const dueIds = new Set(dueConcepts.map((concept) => concept.id));
  const weakConcepts = concepts
    .filter((concept) => concept.evals > 0 && concept.mastery < WEAK_THRESHOLD && !dueIds.has(concept.id))
    .sort((a, b) => a.mastery - b.mastery);
  const weakIds = new Set(weakConcepts.map((concept) => concept.id));
  const freshConcepts = concepts
    .filter((concept) => concept.evals === 0 && !dueIds.has(concept.id) && !weakIds.has(concept.id))
    .sort((a, b) => b.exposure - a.exposure || a.name.localeCompare(b.name));
  const focusList = [
    ...dueConcepts.map((concept) => ({ concept, reason: "到期" as const })),
    ...weakConcepts.map((concept) => ({ concept, reason: "薄弱" as const })),
    ...freshConcepts.map((concept) => ({ concept, reason: "未测" as const })),
  ].slice(0, FOCUS_LIMIT);

  const weekTasks = (heatmap?.days ?? []).slice(-7).reduce((sum, day) => sum + day.tasks, 0);
  const recentSession = [...(courseSessions[courseId ?? ""] ?? sessions)]
    .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)))[0] ?? null;
  const nothingToDo = dueCount === 0 && todo.length === 0;

  const cardsTotal = concepts.reduce((sum, concept) => sum + concept.taskCount, 0);
  const annotationsTotal = concepts.reduce((sum, concept) => sum + concept.annotationCount, 0);
  const unevaluated = concepts.filter((concept) => concept.evals === 0).length;

  // 主题掌握度（账目式边栏）：按章节聚合，只列最需要补的 3 个。
  const chapterStats = new Map<string, { sum: number; count: number }>();
  for (const concept of concepts) {
    const chapter = concept.chapter || "未分组";
    const current = chapterStats.get(chapter) ?? { sum: 0, count: 0 };
    current.sum += concept.mastery;
    current.count += 1;
    chapterStats.set(chapter, current);
  }
  const weakestChapters = [...chapterStats.entries()]
    .map(([chapter, stat]) => ({ chapter, mastery: stat.sum / stat.count, count: stat.count }))
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 3);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-10 py-9" data-focus-zone="center">
      <div className="flex w-full flex-1 flex-col gap-9">
        <QuoteCard />

        <OnboardingGuide />

        {/* 主区（动作）｜ 边栏（上下文）：一条竖直细线的语义分隔，不用卡片墙。 */}
        <div className="grid min-w-0 grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-9">
            <section className="flex flex-col gap-6">
              {dueCount > 0 ? (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <span className="text-[30px] font-semibold leading-none tabular-nums text-text-primary">{dueCount}</span>
                  <span className="text-[15px] text-text-secondary">张卡片到期复习</span>
                  <button
                    type="button"
                    onClick={startReview}
                    className="ml-auto inline-flex min-h-10 shrink-0 items-center rounded-md bg-accent-focus px-5 text-[13.5px] font-medium text-bg-panel transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus"
                  >
                    开始复习
                  </button>
                </div>
              ) : (
                <p className="text-[15px] leading-7 text-text-secondary">
                  {recentHighlights > 0 ? "今天没有到期的复习。" : "今天没有到期的复习，也没有待消化的重点。"}
                </p>
              )}

              {todo.length > 0 ? (
                <ul className="divide-y divide-border-line/60 border-y border-border-line/60">
                  {todo.map((item) => (
                    <li key={item.id} className="flex items-center gap-4 py-3.5">
                      <span className="min-w-0 flex-1 truncate text-[14px] text-text-secondary" title={item.text}>{item.text}</span>
                      <button type="button" onClick={item.run} className={linkClass}>{item.action}</button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {nothingToDo ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <button type="button" onClick={practiceAnything} className={linkClass}>随机练一组题</button>
                  <button type="button" onClick={() => setCenterView("reading")} className={linkClass}>读一份资料</button>
                  <button type="button" onClick={() => { setCenterView("chat"); void createSession(); }} className={linkClass}>新建对话</button>
                </div>
              ) : null}
            </section>

            {focusList.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <h2 className="text-[13px] text-text-muted">该练的概念</h2>
                <ul className="divide-y divide-border-line/60 border-t border-border-line/60">
                  {focusList.map(({ concept, reason }, index) => (
                    <li
                      key={concept.id}
                      className={`relative flex items-center gap-4 py-3 ${index === 0 ? "before:absolute before:inset-y-2.5 before:-left-4 before:w-[2px] before:rounded-full before:bg-accent-focus" : ""}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[14px] text-text-primary" title={concept.name}>{concept.name}</span>
                      <span className="shrink-0 tabular-nums text-[12.5px] text-text-faint">{pct(concept.mastery)}</span>
                      <span
                        className={`w-8 shrink-0 text-right text-[12px] ${reason === "到期" ? "text-accent-warn" : "text-text-faint"}`}
                        title={reason === "到期" ? `已到复习日期${concept.nextReviewAt !== null ? `（${concept.nextReviewAt}）` : ""}` : reason === "薄弱" ? "掌握度偏低" : "从未评测过"}
                      >
                        {reason === "到期" && concept.nextReviewAt !== null ? `到期 ${concept.nextReviewAt.slice(5)}` : reason}
                      </span>
                      <button type="button" onClick={() => practiceConcept(concept.id)} className={`${linkClass} w-10 text-right`}>练它</button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          {/* 边栏：页边注（小字 + 细线 + 账目式 dl），放上下文而不是动作。 */}
          <aside className="flex min-w-0 flex-col gap-7 border-t border-border-line/60 pt-8 lg:border-l lg:border-t-0 lg:pl-12 lg:pt-0">
            <section className="flex flex-col gap-1">
              <p className="text-[14px] text-text-secondary">连续学习 {heatmap?.streak.current ?? 0} 天</p>
              <p className="text-[12.5px] text-text-faint">近 7 天练了 {weekTasks} 题</p>
            </section>

            <section className="flex items-baseline gap-4">
              {recentSession !== null ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-secondary" title={recentSession.title}>
                    继续上次：{recentSession.title || "新对话"}
                  </span>
                  <span className="shrink-0 text-[12px] text-text-faint">{relativeTime(recentSession.lastActiveAt)}</span>
                  <button type="button" onClick={() => { if (courseId !== null) void selectSession(recentSession.sessionId, courseId); }} className={linkClass}>继续</button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-muted">还没有对话记录</span>
                  <button type="button" onClick={() => { setCenterView("chat"); void createSession(); }} className={`${linkClass} inline-flex items-center gap-1`}>
                    <Plus size={12} strokeWidth={1.9} aria-hidden />
                    新建对话
                  </button>
                </>
              )}
            </section>

            <section className="flex items-baseline gap-4">
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-secondary">
                {materialCount === null ? "正在读取资料…" : materialCount > 0 ? `${materialCount} 份资料可阅读` : "还没有导入资料"}
              </span>
              {materialCount === 0 ? (
                <button type="button" onClick={() => openMaterialsDialog("upload")} className={linkClass}>导入资料</button>
              ) : (
                <button type="button" onClick={() => setCenterView("reading")} className={linkClass}>去阅读</button>
              )}
            </section>

            {concepts.length > 0 || progress !== null ? (
              <section className="flex flex-col gap-2.5">
                <h2 className="text-[13px] text-text-muted">课程概览</h2>
                <dl className="divide-y divide-border-line/50 border-y border-border-line/60 text-[13px]">
                  {([
                    ["总体掌握度", pct(progress?.overallMastery ?? 0)],
                    ["概念", String(concepts.length)],
                    ["题卡", String(cardsTotal)],
                    ["关联标注", String(annotationsTotal)],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between py-2">
                      <dt className="text-text-faint" title={label === "关联标注" ? "已关联到概念的划线数（未关联的不计入）" : undefined}>{label}</dt>
                      <dd className="tabular-nums text-text-primary">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex items-center justify-between gap-3">
                  {unevaluated > 0 ? <span className="text-[12.5px] text-text-faint">{unevaluated} 个概念还没测过</span> : <span />}
                  <button type="button" onClick={() => { setActiveTab("syllabus"); setRightPanelCollapsed(false); }} className={linkClass}>看大纲</button>
                </div>
              </section>
            ) : null}

            {weakestChapters.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <h2 className="text-[13px] text-text-muted">需要补的主题</h2>
                <ul className="divide-y divide-border-line/50 border-y border-border-line/60 text-[13px]">
                  {weakestChapters.map((item) => (
                    <li key={item.chapter} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="min-w-0 truncate text-text-secondary" title={item.chapter}>{item.chapter}</span>
                      <span className="shrink-0 tabular-nums text-text-faint">{pct(item.mastery)} · {item.count} 个</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
