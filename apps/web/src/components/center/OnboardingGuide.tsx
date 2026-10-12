"use client";

/**
 * F1：新手引导卡片（六步路径）。
 *
 * 每张卡都有可直接执行的入口，完成条件来自真实数据而不是点击动作。支持隐藏
 * 与重新打开；已有课程按真实状态跳过已经完成的准备工作。欢迎内容与「今天」
 * 说明合并，避免首屏两张解释卡叠加。
 */

import { useEffect, useState } from "react";
import { ChevronDown, Compass, Sparkles, X } from "lucide-react";
import { api } from "@/src/lib/api";
import { openConceptDialog } from "@/src/lib/conceptDialog";
import { startConceptFill } from "@/src/lib/conceptFillFlow";
import { openMaterialsDialog } from "@/src/lib/materialsDialog";
import { quizLoad } from "@/src/lib/quizFlow";
import {
  completedCount,
  computeOnboardingSteps,
  modelTestMatches,
  nextStep,
  persistOnboardingHidden,
  readModelTestEvidence,
  readOnboardingHidden,
  scenarioHint,
  type OnboardingInputs,
  type OnboardingStepId,
} from "@/src/lib/onboarding";
import { useAppStore } from "@/src/store/useAppStore";
import { panelSurfaceClass } from "@/src/components/panel/PanelPrimitives";

function useOnboardingInputs(): OnboardingInputs {
  const courseId = useAppStore((s) => s.activeCourseId);
  const courses = useAppStore((s) => s.courses);
  const progress = useAppStore((s) => s.progress);
  const digest = useAppStore((s) => s.digest);
  const revision = useAppStore((s) => s.courseDataRevision);
  const lastImportAt = useAppStore((s) => s.lastImport?.at ?? "");
  const [modelReady, setModelReady] = useState(false);
  const [modelTested, setModelTested] = useState(false);
  const [materials, setMaterials] = useState<{ key: string; count: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const payload = await api.settings().catch(() => null);
      if (!alive || payload === null) return;
      const ready = payload.llm.apiBase !== null && payload.llm.model !== "" && payload.llm.apiKeyConfigured;
      const config = { providerId: payload.activeProviderId, model: payload.llm.model, baseUrl: payload.llm.apiBase ?? "" };
      setModelReady(ready);
      setModelTested(modelTestMatches(readModelTestEvidence(), config));
    };
    void load();
    const onTested = () => void load();
    window.addEventListener("studyclaw:model-tested", onTested);
    return () => {
      alive = false;
      window.removeEventListener("studyclaw:model-tested", onTested);
    };
  }, [courseId, revision]);

  const materialKey = courseId === null ? null : `${courseId}:${lastImportAt}:${revision}`;
  useEffect(() => {
    if (courseId === null || materialKey === null) return;
    let alive = true;
    void api.courseFiles(courseId).then((payload) => {
      if (alive) setMaterials({ key: materialKey, count: payload.files.filter((file) => file.supported).length });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [courseId, materialKey]);

  const activeCourse = courses.find(course => course.id === courseId) ?? null;
  const adoptedConcepts = progress?.concepts.length ?? 0;
  const evaluatedConcepts = digest?.concepts.filter(concept => concept.evals > 0).length ?? progress?.concepts.filter(concept => concept.evals > 0).length ?? 0;
  const coveredConcepts = digest?.concepts.filter(concept => concept.taskCount > 0).length ?? 0;
  return {
    hasCourse: courseId !== null && activeCourse !== null,
    courseName: activeCourse?.title ?? null,
    modelReady,
    modelTested,
    aiEvidence: progress?.conceptOrigin === "semantic" || evaluatedConcepts > 0,
    materialCount: materials !== null && materials.key === materialKey ? materials.count : 0,
    conceptOrigin: progress?.conceptOrigin ?? "headings",
    adoptedConcepts,
    coveredConcepts,
    evaluatedConcepts,
  };
}

export default function OnboardingGuide() {
  const hidden = useAppStore((s) => s.onboardingHidden);
  const setOnboardingHidden = useAppStore((s) => s.setOnboardingHidden);
  const setWizardOpen = useAppStore((s) => s.setWizardOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const setCenterView = useAppStore((s) => s.setCenterView);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setRightPanelCollapsed = useAppStore((s) => s.setRightPanelCollapsed);
  const [expanded, setExpanded] = useState(false);
  const inputs = useOnboardingInputs();

  // 启动时恢复隐藏偏好（SSR 阶段默认显示）。
  useEffect(() => {
    setOnboardingHidden(readOnboardingHidden());
  }, [setOnboardingHidden]);

  if (hidden) return null;

  const steps = computeOnboardingSteps(inputs);
  const done = completedCount(steps);
  const current = nextStep(steps);
  const allDone = current === null;
  const hint = scenarioHint(inputs);

  function hide() {
    persistOnboardingHidden(true);
    setOnboardingHidden(true);
  }

  function runStep(id: OnboardingStepId): void {
    if (id === "course") { setWizardOpen(true); return; }
    if (id === "model") { setSettingsSection("models"); setSettingsOpen(true); return; }
    if (id === "material") { openMaterialsDialog(inputs.hasCourse ? "upload" : "import"); return; }
    if (id === "concept") { openConceptDialog(); return; }
    if (id === "cards") { void startConceptFill(); return; }
    setCenterView("chat");
    setActiveTab("quiz");
    setRightPanelCollapsed(false);
    void quizLoad("new");
  }

  function startPractice(): void {
    setCenterView("chat");
    setActiveTab("quiz");
    setRightPanelCollapsed(false);
    void quizLoad("new");
  }

  function startReading(): void {
    setCenterView("reading");
  }

  // 从零开始：整卡欢迎 + 主按钮「开始引导」。
  if (!inputs.hasCourse) {
    return (
      <div className={`w-full ${panelSurfaceClass} p-5`} data-testid="onboarding-guide">
        <div className="flex items-center gap-2">
          <Compass size={15} strokeWidth={1.8} className="text-accent-focus" aria-hidden />
          <h2 className="text-[14px] font-medium text-text-primary">开始你的第一门课程</h2>
          <button type="button" aria-label="隐藏引导" title="隐藏引导" onClick={hide} className="ml-auto flex h-6 w-6 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary">
            <X size={13} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-text-muted">
          六步走完，就能从一堆资料变成会出题、会安排复习的私教。首屏只回答一个问题：现在该做什么。
        </p>
        <ol className="mt-3 space-y-1 text-[12px] leading-5 text-text-secondary">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border-line text-[9px] text-text-faint">{steps.indexOf(step) + 1}</span>
              <span>{step.title}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setWizardOpen(true)} className="inline-flex min-h-9 items-center rounded-md bg-accent-focus px-4 text-[13px] font-medium text-bg-panel transition-opacity hover:opacity-90">
            开始引导
          </button>
          <button type="button" onClick={() => setWizardOpen(true)} className="inline-flex min-h-9 items-center rounded-md border border-border-line px-3 text-[13px] text-text-muted transition-colors hover:text-text-primary">
            打开已有课程
          </button>
          <button type="button" onClick={hide} className="ml-auto text-[12px] text-text-faint transition-colors hover:text-text-muted">
            先看看
          </button>
        </div>
      </div>
    );
  }

  // 全部完成：不再是一张卡盒，收成一行"页边信息"——与「今天」的留白取向一致。
  if (allDone) {
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="onboarding-guide">
        <span className="text-[13px] text-text-secondary">第一门课程已经准备好了</span>
        <span className="text-[12px] text-text-faint">已完成 {done}/6</span>
        <button type="button" onClick={startReading} className="text-[13px] text-accent-focus transition-colors hover:underline">阅读资料</button>
        <button type="button" onClick={startPractice} className="text-[13px] text-accent-focus transition-colors hover:underline">继续练习</button>
        <button type="button" aria-label="隐藏引导" title="隐藏引导" onClick={hide} className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary">
          <X size={13} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className={`w-full ${panelSurfaceClass} p-4`} data-testid="onboarding-guide">
      <div className="flex items-center gap-2">
        <Compass size={14} strokeWidth={1.8} className="shrink-0 text-accent-focus" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
          下一步：{current.title}
        </span>
        <span className="shrink-0 text-[11px] text-text-faint">已完成 {done}/6</span>
        <button type="button" aria-label="隐藏引导" title="隐藏引导" onClick={hide} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary">
          <X size={13} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => runStep(current.id)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent-focus px-3 text-[12px] font-medium text-bg-panel transition-opacity hover:opacity-90">
          <Sparkles size={12} strokeWidth={1.9} aria-hidden />
          {current.actionLabel}
        </button>
        {hint !== null ? <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted" title={hint.text}>{hint.text}</span> : null}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 text-[11px] text-text-faint transition-colors hover:text-text-muted"
        >
          <ChevronDown size={12} strokeWidth={1.8} className={expanded ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden />
          {expanded ? "收起" : "全部步骤"}
        </button>
      </div>

      {expanded ? (
        <ol className="mt-3 space-y-1.5">
          {steps.map((step, index) => (
            <li key={step.id} className="flex items-start gap-2 text-[12px] leading-5">
              <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${step.done ? "border-accent-pass bg-accent-pass/10 text-accent-pass" : "border-border-line text-text-faint"}`}>
                {step.done ? "✓" : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={step.done ? "text-text-muted line-through" : "text-text-primary"}>{step.title}</span>
                <span className="block text-[11px] text-text-faint">{step.description}</span>
              </span>
              {!step.done ? (
                <button type="button" onClick={() => runStep(step.id)} className="shrink-0 text-[11px] text-accent-focus">
                  {step.actionLabel}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
