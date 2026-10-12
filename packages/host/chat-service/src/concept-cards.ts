/**
 * 概念补题闭环（PRD F2）：只给「已采用 AI 概念、且当前没有有效题卡」的概念补题。
 *
 * 与 build job 分开：补题需要逐概念结果、真实进度、部分成功与取消，通用
 * JobManager 的单一 result 结构无法承载。任务表是内存态——已落盘的题卡才是
 * 重启后的真实恢复依据（按实际题池重算剩余缺题）。
 * @module @studyclaw/chat-service/src/concept-cards
 */
import { randomUUID } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { resolveSourceRef, withCourseLock } from '@studyclaw/tools';
import { LlmTaskGenerator, loadSyllabus, loadTaskPool, readSourceDocument, stateDirOf, writeTaskPool } from '@studyclaw/course-builder';
import { createDeepSeekToolClient } from './adapter.ts';
import type { ResolvedChatConfig } from './config.ts';

/** 每个缺题概念的目标题卡数（PRD：沿用默认两张）。 */
export const CARDS_PER_CONCEPT = 2;

export interface ConceptCoverage {
  readonly conceptId: string;
  readonly name: string;
  readonly chapter: string;
  readonly covered: boolean;
  readonly cardCount: number;
}

export interface ConceptCardStatus {
  readonly modelReady: boolean;
  readonly conceptOrigin: 'semantic' | 'headings';
  readonly totalConcepts: number;
  readonly coveredConcepts: number;
  readonly missingConcepts: number;
  readonly missing: ReadonlyArray<{ readonly id: string; readonly name: string; readonly chapter: string }>;
  readonly concepts: readonly ConceptCoverage[];
}

export type ConceptFillItemStatus = 'pending' | 'running' | 'filled' | 'covered' | 'failed' | 'unprocessed';

export interface ConceptFillItem {
  readonly conceptId: string;
  readonly name: string;
  readonly status: ConceptFillItemStatus;
  /** 实际落盘张数（任务级，重试会以真实题池重算）。 */
  readonly generated: number;
  readonly reason: string | null;
}

export interface ConceptFillJobView {
  readonly jobId: string;
  readonly courseId: string;
  readonly status: 'running' | 'done' | 'stopped' | 'failed';
  /** 启动时确认的缺题概念数（目标总数）。 */
  readonly total: number;
  /** 补题前已被有效题卡覆盖的概念数。 */
  readonly coveredBefore: number;
  /** 已处理完成的缺题概念数（filled + failed）。 */
  readonly processed: number;
  /** 本次实际新增并落盘的题卡张数。 */
  readonly generated: number;
  readonly currentConcept: string | null;
  readonly items: readonly ConceptFillItem[];
  readonly error: string | null;
  /** 共享失败原因（认证/额度/端点不可用）——出现时后续概念暂停，标为未处理。 */
  readonly sharedProblem: string | null;
}

/** 有效题卡：未废弃、归属该概念，即可进入练习的卡片。 */
function hasValidCard(pool: Array<{ concept_id: string; deprecated?: boolean }>, conceptId: string): boolean {
  return pool.some(task => !task.deprecated && task.concept_id === conceptId);
}

/** 只读覆盖统计：不发送任何模型请求。 */
export async function conceptCardStatus(root: string, modelReady: boolean): Promise<ConceptCardStatus> {
  const syllabus = await loadSyllabus(root);
  const pool = await loadTaskPool(root);
  const concepts: ConceptCoverage[] = [];
  for (const chapter of syllabus.chapters) {
    for (const concept of chapter.concepts) {
      const cardCount = pool.filter(task => !task.deprecated && task.concept_id === concept.id).length;
      concepts.push({ conceptId: concept.id, name: concept.name, chapter: chapter.title, covered: cardCount > 0, cardCount });
    }
  }
  const missing = concepts.filter(item => !item.covered);
  return {
    modelReady,
    conceptOrigin: syllabus.concept_origin === 'semantic' ? 'semantic' : 'headings',
    totalConcepts: concepts.length,
    coveredConcepts: concepts.length - missing.length,
    missingConcepts: missing.length,
    missing: missing.map(item => ({ id: item.conceptId, name: item.name, chapter: item.chapter })),
    concepts,
  };
}

/**
 * 共享失败识别：认证失败、额度耗尽、端点不可用等对「所有概念」都成立的错误，
 * 继续逐个概念请求只会重复烧钱并延迟反馈。命中后暂停后续处理，已保存结果保留。
 *
 * 适配器会把上游错误体 message 透出（401 时只剩 "Authentication Fails..."，不带
 * HTTP 状态码），因此这里既匹配状态码也匹配认证/额度/限流关键词。
 */
export function isSharedModelProblem(message: string): boolean {
  return /缺少 API Key|Provider 未配置凭据|模型不可用|无法连接模型端点|端点返回 HTTP|HTTP\s*(401|402|403|404|429)|DeepSeek API error|Authentication|Unauthorized|invalid api key|permission denied|insufficient|余额|quota|rate limit|ECONNREFUSED|ENOTFOUND|fetch failed|Base URL/i.test(message);
}

interface MutableItem {
  conceptId: string;
  name: string;
  status: ConceptFillItemStatus;
  generated: number;
  reason: string | null;
}

interface MutableJob {
  readonly jobId: string;
  readonly courseId: string;
  readonly root: string;
  status: 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  coveredBefore: number;
  generated: number;
  currentConcept: string | null;
  items: MutableItem[];
  error: string | null;
  sharedProblem: string | null;
  finishedAtMs: number | null;
  readonly abort: AbortController;
}

function view(job: MutableJob): ConceptFillJobView {
  const processed = job.items.filter(item => item.status === 'filled' || item.status === 'failed').length;
  return {
    jobId: job.jobId,
    courseId: job.courseId,
    status: job.status,
    total: job.total,
    coveredBefore: job.coveredBefore,
    processed,
    generated: job.generated,
    currentConcept: job.currentConcept,
    items: job.items.map(item => ({ ...item })),
    error: job.error,
    sharedProblem: job.sharedProblem,
  };
}

/** 内存补题任务表（模块级单例，跨 createCourseService 实例共享同课程去重）。 */
class ConceptFillJobs {
  private readonly jobs = new Map<string, MutableJob>();
  private static readonly FINISHED_TTL_MS = 10 * 60 * 1000;

  start(root: string, courseId: string, config: ResolvedChatConfig): string {
    this.sweep();
    for (const job of this.jobs.values()) {
      if (job.root === root && job.finishedAtMs === null) return job.jobId;
    }
    const jobId = `cfill_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const job: MutableJob = {
      jobId, courseId, root, status: 'running', total: 0, coveredBefore: 0, generated: 0,
      currentConcept: null, items: [], error: null, sharedProblem: null, finishedAtMs: null, abort: new AbortController(),
    };
    this.jobs.set(jobId, job);
    void this.run(job, config);
    return jobId;
  }

  get(jobId: string): ConceptFillJobView | undefined {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : view(job);
  }

  stop(jobId: string): ConceptFillJobView | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    if (job.finishedAtMs === null) {
      job.abort.abort('stopped');
      job.status = 'stopped';
      job.currentConcept = null;
      for (const item of job.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'unprocessed';
          item.reason = item.reason ?? '已停止';
        }
      }
      job.finishedAtMs = Date.now();
    }
    return view(job);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (job.finishedAtMs !== null && now - job.finishedAtMs > ConceptFillJobs.FINISHED_TTL_MS) this.jobs.delete(jobId);
    }
  }

  private async run(job: MutableJob, config: ResolvedChatConfig): Promise<void> {
    try {
      await this.execute(job, config);
    } catch (error) {
      if (job.abort.signal.aborted) {
        job.status = 'stopped';
      } else {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      job.currentConcept = null;
      job.finishedAtMs = Date.now();
    }
  }

  private async execute(job: MutableJob, config: ResolvedChatConfig): Promise<void> {
    const syllabus = await loadSyllabus(job.root);
    if (syllabus.concept_origin !== 'semantic') throw new Error('请先预览并采用 AI 概念，再补齐题卡');
    const pool = await loadTaskPool(job.root);
    const adopted = syllabus.chapters.flatMap(chapter => chapter.concepts.map(concept => ({ chapter, concept })));
    job.items = adopted.map(({ concept }) => ({
      conceptId: concept.id,
      name: concept.name,
      status: hasValidCard(pool, concept.id) ? 'covered' : 'pending',
      generated: 0,
      reason: null,
    }));
    const missingIds = new Set(job.items.filter(item => item.status === 'pending').map(item => item.conceptId));
    job.coveredBefore = job.items.length - missingIds.size;
    job.total = missingIds.size;
    if (missingIds.size === 0) return;

    const client = createDeepSeekToolClient({ ...config, reasoningEffort: ReasoningEffortId('off') });
    const signal = job.abort.signal;
    // 每概念请求都携带同一个 job signal：停止即取消后台模型请求。
    const generator = new LlmTaskGenerator(
      { stream: options => client.stream({ ...options, signal }) },
      { provider: config.providerId || 'studyclaw', model: config.model, temperature: 0.2 },
    );

    for (const item of job.items) {
      if (item.status !== 'pending') continue;
      if (signal.aborted) break;
      const entry = adopted.find(candidate => candidate.concept.id === item.conceptId)!;
      const concept = entry.concept;
      item.status = 'running';
      job.currentConcept = concept.name;
      try {
        const ref = concept.evidence?.[0];
        if (!ref) throw new Error('概念没有可出题的原文依据，请重新提炼');
        const path = await resolveSourceRef(job.root, ref.source);
        const document = await readSourceDocument(path, ref.source, stateDirOf(job.root));
        const context = document.blocks
          .filter(block => concept.evidence!.some(evidence => evidence.block_id === block.id))
          .map(block => block.text)
          .join('\n\n');
        if (!context) throw new Error('概念依据已过期，请重新提炼');
        const cards = await generator.generateTasks({
          chunk_id: ref.block_id,
          chapter_id: entry.chapter.id,
          concept_id: concept.id,
          title: concept.name,
          content: `${concept.definition}\n学习目标：${concept.learning_objective}\n\n原文：\n${context}`,
          source_ref: { file: ref.source, chunk_id: ref.block_id, page: ref.page },
        }, CARDS_PER_CONCEPT);
        if (signal.aborted) { break; }
        // 落盘与「是否已覆盖」复核在同一把课程锁内：并发任务补好同一概念时不重复入池。
        const outcome = await withCourseLock(job.root, async () => {
          const current = await loadTaskPool(job.root);
          if (hasValidCard(current, concept.id)) return { status: 'covered' as const, count: 0 };
          if (!(await loadSyllabus(job.root)).chapters.some(chapter => chapter.concepts.some(next => next.id === concept.id))) {
            throw new Error('课程概念已变化，请刷新后重试');
          }
          const ids = new Set(current.map(task => task.task_id));
          const unique = cards.map(card => ({ ...card, task_id: ids.has(card.task_id) ? `${card.task_id}_${randomUUID().slice(0, 8)}` : card.task_id }));
          if (unique.length === 0) return { status: 'empty' as const, count: 0 };
          await writeTaskPool(job.root, [...current, ...unique]);
          return { status: 'filled' as const, count: unique.length };
        });
        if (outcome.status === 'covered') {
          item.status = 'covered';
          item.reason = '已覆盖，跳过';
        } else if (outcome.status === 'empty') {
          item.status = 'failed';
          item.reason = '模型未生成符合题卡契约的卡片';
        } else {
          item.status = 'filled';
          item.generated = outcome.count;
          job.generated += outcome.count;
        }
      } catch (error) {
        if (signal.aborted) { break; }
        const message = error instanceof Error ? error.message : String(error);
        if (isSharedModelProblem(message)) {
          item.status = 'unprocessed';
          item.reason = message;
          job.sharedProblem = message;
          for (const rest of job.items) {
            if (rest.status === 'pending') { rest.status = 'unprocessed'; rest.reason = message; }
          }
          break;
        }
        item.status = 'failed';
        item.reason = message;
      }
    }
    // 正常走完（未被共享问题中断、未停止）才算完成；停止/暂停已由状态字段表达。
    if (!signal.aborted) job.status = 'done';
  }
}

const conceptFillJobs = new ConceptFillJobs();

export function startConceptCardFill(root: string, courseId: string, config: ResolvedChatConfig): string {
  return conceptFillJobs.start(root, courseId, config);
}

export function conceptCardFillJob(jobId: string): ConceptFillJobView | undefined {
  return conceptFillJobs.get(jobId);
}

export function stopConceptCardFill(jobId: string): ConceptFillJobView | undefined {
  return conceptFillJobs.stop(jobId);
}
