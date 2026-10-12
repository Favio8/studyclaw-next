/**
 * F1 新手引导：六步完成状态只来自真实数据。
 *
 * 防止「点了按钮就算完成」「跳过被当成完成」和「老用户升级被要求重做」三类回归。
 */

import { describe, expect, it } from "vitest";
import {
  completedCount,
  computeOnboardingSteps,
  modelTestMatches,
  nextStep,
  scenarioHint,
  type OnboardingInputs,
} from "../src/lib/onboarding";

function base(overrides: Partial<OnboardingInputs> = {}): OnboardingInputs {
  return {
    hasCourse: false,
    courseName: null,
    modelReady: false,
    modelTested: false,
    aiEvidence: false,
    materialCount: 0,
    conceptOrigin: "headings",
    adoptedConcepts: 0,
    coveredConcepts: 0,
    evaluatedConcepts: 0,
    ...overrides,
  };
}

describe("computeOnboardingSteps", () => {
  it("全新用户：六步全部未完成，下一步是选课程目录", () => {
    const steps = computeOnboardingSteps(base());
    expect(completedCount(steps)).toBe(0);
    expect(nextStep(steps)?.id).toBe("course");
  });

  it("模型配置需要成功证据：仅保存配置不算完成", () => {
    const savedOnly = computeOnboardingSteps(base({ hasCourse: true, modelReady: true }));
    expect(savedOnly.find(step => step.id === "model")?.done).toBe(false);

    const tested = computeOnboardingSteps(base({ hasCourse: true, modelReady: true, modelTested: true }));
    expect(tested.find(step => step.id === "model")?.done).toBe(true);

    const aiUsed = computeOnboardingSteps(base({ hasCourse: true, modelReady: true, aiEvidence: true }));
    expect(aiUsed.find(step => step.id === "model")?.done).toBe(true);
  });

  it("题卡步骤要求全部已采用概念都有有效题卡", () => {
    const partial = computeOnboardingSteps(base({ hasCourse: true, conceptOrigin: "semantic", adoptedConcepts: 4, coveredConcepts: 2 }));
    expect(partial.find(step => step.id === "cards")?.done).toBe(false);
    const full = computeOnboardingSteps(base({ hasCourse: true, conceptOrigin: "semantic", adoptedConcepts: 4, coveredConcepts: 4 }));
    expect(full.find(step => step.id === "cards")?.done).toBe(true);
  });

  it("已有课程的老用户按真实成果跳过已完成步骤，不强制重做", () => {
    const steps = computeOnboardingSteps(base({
      hasCourse: true, courseName: "旧课程",
      modelReady: true, aiEvidence: true,
      materialCount: 3, conceptOrigin: "semantic", adoptedConcepts: 8, coveredConcepts: 8, evaluatedConcepts: 5,
    }));
    expect(completedCount(steps)).toBe(6);
    expect(nextStep(steps)).toBeNull();
  });

  it("手动章节大纲的概念提炼步骤未完成", () => {
    const steps = computeOnboardingSteps(base({ hasCourse: true, conceptOrigin: "headings", adoptedConcepts: 3 }));
    expect(steps.find(step => step.id === "concept")?.done).toBe(false);
  });
});

describe("scenarioHint", () => {
  it("按最前置的缺口给出可执行提示", () => {
    expect(scenarioHint(base())?.stepId).toBe("course");
    expect(scenarioHint(base({ hasCourse: true }))?.stepId).toBe("model");
    expect(scenarioHint(base({ hasCourse: true, modelReady: true }))?.stepId).toBe("material");
    expect(scenarioHint(base({ hasCourse: true, modelReady: true, materialCount: 2 }))?.stepId).toBe("concept");
    expect(scenarioHint(base({
      hasCourse: true, modelReady: true, materialCount: 2, conceptOrigin: "semantic", adoptedConcepts: 4, coveredConcepts: 1,
    }))?.stepId).toBe("cards");
    expect(scenarioHint(base({
      hasCourse: true, modelReady: true, materialCount: 2, conceptOrigin: "semantic", adoptedConcepts: 4, coveredConcepts: 4,
    }))?.stepId).toBe("practice");
  });
});

describe("modelTestMatches", () => {
  it("端点/模型/供应商任一变化后，旧成功证据不再匹配", () => {
    const evidence = { providerId: "deepseek", model: "m1", baseUrl: "https://api.deepseek.com", at: "" };
    expect(modelTestMatches(evidence, { providerId: "deepseek", model: "m1", baseUrl: "https://api.deepseek.com/" })).toBe(true);
    expect(modelTestMatches(evidence, { providerId: "deepseek", model: "m2", baseUrl: "https://api.deepseek.com" })).toBe(false);
    expect(modelTestMatches(evidence, { providerId: "other", model: "m1", baseUrl: "https://api.deepseek.com" })).toBe(false);
    expect(modelTestMatches(null, { providerId: "deepseek", model: "m1", baseUrl: "https://api.deepseek.com" })).toBe(false);
  });
});
