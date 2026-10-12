/**
 * F1 新手引导：六步路径的完成状态计算（纯函数）。
 *
 * 完成条件一律来自真实数据（课程/模型配置与测试证据/资料/已采用概念/题卡覆盖/
 * 已保存评测），点击按钮、跳过或关闭弹窗都不计完成。模型配置的「成功证据」只有
 * 两种：用户明确发起且成功的连通测试，或该配置已有真实 AI 请求成功（如已采用
 * AI 概念、已完成评测）。
 */

export type OnboardingStepId = "course" | "model" | "material" | "concept" | "cards" | "practice";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  actionLabel: string;
  done: boolean;
}

export interface OnboardingInputs {
  hasCourse: boolean;
  courseName: string | null;
  modelReady: boolean;
  modelTested: boolean;
  aiEvidence: boolean;
  materialCount: number;
  conceptOrigin: "semantic" | "headings";
  adoptedConcepts: number;
  coveredConcepts: number;
  evaluatedConcepts: number;
}

export const MODEL_TEST_KEY = "studyclaw.modelTest.v1";
/** 引导隐藏偏好（可随时重新打开）。 */
export const ONBOARDING_HIDDEN_KEY = "studyclaw.onboarding.hidden.v1";

export function persistOnboardingHidden(hidden: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (hidden) window.localStorage.setItem(ONBOARDING_HIDDEN_KEY, "1");
    else window.localStorage.removeItem(ONBOARDING_HIDDEN_KEY);
  } catch {
    // 写不进去只影响下次是否默认隐藏。
  }
}

export function readOnboardingHidden(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ModelTestEvidence {
  providerId: string;
  model: string;
  baseUrl: string;
  at: string;
}

export function readModelTestEvidence(): ModelTestEvidence | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MODEL_TEST_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ModelTestEvidence>;
    if (typeof parsed.providerId !== "string" || typeof parsed.model !== "string" || typeof parsed.baseUrl !== "string") return null;
    return { providerId: parsed.providerId, model: parsed.model, baseUrl: parsed.baseUrl, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

/** 保存成功证据；端点/凭据/模型变化后旧证据不再匹配，因此不会被误用。 */
export function writeModelTestEvidence(evidence: Omit<ModelTestEvidence, "at">): void {
  if (typeof window === "undefined") return;
  const record: ModelTestEvidence = { ...evidence, at: new Date().toISOString() };
  try {
    window.localStorage.setItem(MODEL_TEST_KEY, JSON.stringify(record));
  } catch {
    // 写不进去只影响「下次是否还显示已测试」，不影响本次结论。
  }
}

export function clearModelTestEvidence(): void {  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MODEL_TEST_KEY);
  } catch {
    // 忽略。
  }
}

/** 当前配置是否与一次成功测试证据完全一致（provider + model + baseUrl）。 */
export function modelTestMatches(
  evidence: ModelTestEvidence | null,
  current: { providerId: string; model: string; baseUrl: string },
): boolean {
  if (evidence === null) return false;
  return evidence.providerId === current.providerId
    && evidence.model === current.model
    && evidence.baseUrl.replace(/\/+$/, "") === current.baseUrl.replace(/\/+$/, "");
}

const STEPS: Array<Omit<OnboardingStep, "done">> = [
  { id: "course", title: "新建第一门课程", description: "选择保存这门课资料和学习记录的文件夹", actionLabel: "选择课程目录" },
  { id: "model", title: "配置 AI 模型", description: "选择供应商、填写 API Key、选择模型，并做一次连通测试", actionLabel: "打开模型配置" },
  { id: "material", title: "导入第一份资料", description: "加入 PDF、Word、PPT、图片或文本", actionLabel: "导入资料" },
  { id: "concept", title: "确认学习概念", description: "AI 提炼知识点，你可以改名或取消采用", actionLabel: "AI 概念提炼" },
  { id: "cards", title: "生成练习题卡", description: "为缺题概念生成题卡", actionLabel: "补齐题卡" },
  { id: "practice", title: "完成第一次练习", description: "回答一道题，体验反馈和复习安排", actionLabel: "开始测验" },
];

export function computeOnboardingSteps(input: OnboardingInputs): OnboardingStep[] {
  const evaluationUsed = input.aiEvidence && input.evaluatedConcepts > 0;
  const covered = input.adoptedConcepts > 0 && input.coveredConcepts >= input.adoptedConcepts;
  const doneById: Record<OnboardingStepId, boolean> = {
    course: input.hasCourse,
    model: input.modelReady && (input.modelTested || input.aiEvidence),
    material: input.materialCount > 0,
    concept: input.conceptOrigin === "semantic" && input.adoptedConcepts > 0,
    cards: covered,
    practice: evaluationUsed || input.evaluatedConcepts > 0,
  };
  return STEPS.map(step => ({ ...step, done: doneById[step.id] }));
}

export function completedCount(steps: readonly OnboardingStep[]): number {
  return steps.filter(step => step.done).length;
}

/** 当前应推进的步骤（第一个未完成）；全部完成时返回 null。 */
export function nextStep(steps: readonly OnboardingStep[]): OnboardingStep | null {
  return steps.find(step => !step.done) ?? null;
}

/** 场景提示（PRD 4.4）：返回当前最值得说明的一句与对应动作步骤。 */
export function scenarioHint(input: OnboardingInputs): { text: string; stepId: OnboardingStepId } | null {
  if (!input.hasCourse) return { text: "先选择课程文件夹，我们会在这里保存资料和学习记录。", stepId: "course" };
  if (!input.modelReady) return { text: "资料可以先阅读；AI 提炼和概括需要配置模型。", stepId: "model" };
  if (input.materialCount === 0) return { text: "把第一份资料放进课程文件夹，就能开始提炼知识点。", stepId: "material" };
  if (input.conceptOrigin !== "semantic" || input.adoptedConcepts === 0) return { text: "从资料提炼学习概念，确认后再生成题卡。", stepId: "concept" };
  if (input.coveredConcepts < input.adoptedConcepts) return { text: `还有 ${input.adoptedConcepts - input.coveredConcepts} 个概念没有题卡。`, stepId: "cards" };
  if (input.evaluatedConcepts === 0) return { text: "题卡已就绪，做一道题把知识变成掌握度。", stepId: "practice" };
  return null;
}
