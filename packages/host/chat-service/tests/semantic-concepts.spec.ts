import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { harnessTask, loadSyllabus, loadTaskPool, saveProgressBoard, loadProgressBoard, writeTaskPool, readZip } from '@studyclaw/course-builder';
import { createCourseService } from '../src/course.ts';
import { applyConcepts, groundedCandidates } from '../src/concepts.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Grounded semantic concepts', () => {
  it('keeps real source/page anchors, rejects invented quotes, unknown blocks and section labels', () => {
    const candidate = { name: '显式记忆', area: '记忆表示', definition: '通过检索外部记录保存记忆。', learning_objective: '能够辨别显式与隐式存储。', evidence: [{ block_id: 'p7', quote: 'Explicit memory retrieves external records.' }] };
    const result = groundedCandidates({ concepts: [candidate, { ...candidate, name: 'INTRODUCTION' }, { ...candidate, name: 'paper.pdf' }, { ...candidate, evidence: [{ block_id: 'p99', quote: candidate.evidence[0]!.quote }] }, { ...candidate, evidence: [{ block_id: 'p7', quote: 'Memory is always perfect.' }] }] }, [{ id: 'p7', source: 'paper.pdf', page: 7, text: candidate.evidence[0]!.quote }]);
    expect(result.rejected).toBe(4);
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0]!.evidence[0]).toMatchObject({ source: 'paper.pdf', page: 7 });
  });

  async function seed() {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-semantic-')); roots.push(root);
    const state = join(root, '.studyclaw'); await mkdir(join(state, 'concepts'), { recursive: true });
    await writeFile(join(state, '.layout-v2'), 'v2\n');
    const text = 'Explicit memory retrieves external records. Implicit memory is encoded in weights.';
    await writeFile(join(root, 'paper.md'), text);
    const old = { course_id: basename(root), title: 'Memory', version: '1.0.0', granularity: 'fine', chapters: [{ id: 'chap_old', title: 'INTRODUCTION', description: '', dependencies: [], source_file: 'paper.md', concepts: [{ id: 'c_old', name: 'paper.md', type: 'mechanism', prerequisites: [], mastery_score: 0.9 }] }], adjacency: {} };
    await writeFile(join(state, 'syllabus.json'), JSON.stringify(old));
    await writeFile(join(state, 'notes.md'), 'My unchanged notes.');
    const task = harnessTask.parse({ task_id: 'h_old', concept_id: 'c_old', source_ref: { file: 'paper.md', chunk_id: 'old' }, type: 'concept', difficulty: 2, question: 'Where does explicit memory store records?', options: ['External records', 'Only weights', 'Nowhere', 'Only attention'], answer_index: 0, evaluation_criteria: { rubric: ['Identify external records', 'Distinguish weights'] }, history: { attempts: 5, last_score: 0.8, pass_count: 4, next_review_at: '2026-11-01', ef: 2.8 } });
    await writeTaskPool(root, [task]);
    await saveProgressBoard(join(state, 'progress.md'), { overallMastery: 0.9, dueCount: 0, lastUpdatedAt: null, concepts: [{ conceptId: 'c_old', name: 'paper.md', chapter: 'INTRODUCTION', mastery: 0.9, evals: 5, passRate: 0.8, streak: 4, ef: 2.8, nextReviewAt: '2026-11-01', misattribution: '无', exposure: 2 }] });
    const syllabus = await loadSyllabus(root), tasks = await loadTaskPool(root);
    const baseline = createHash('sha256').update(JSON.stringify([syllabus, tasks.map(row => [row.task_id, row.concept_id, row.question, row.options, row.deprecated])])).digest('hex');
    const draft = { id: '51497217-3850-414b-8f7e-625a1dacdb77', baseline, createdAt: new Date().toISOString(), rejected: 0, concepts: [{ id: 'c_sem_explicit', name: '显式记忆', area: '表示', definition: '在模型外保存记录。', learning_objective: '区分外部与参数内存储。', evidence: [{ source: 'paper.md', page: 1, block_id: 'p1', quote: 'Explicit memory retrieves external records.' }] }], bindings: [{ task_id: 'h_old', concept_id: 'c_sem_explicit' }], sources: [{ source: 'paper.md', sha256: createHash('sha256').update(text).digest('hex') }] };
    await writeFile(join(state, 'concepts', 'draft.json'), JSON.stringify(draft));
    return { root, state, task, draft };
  }

  it('adopts semantic concepts while retaining task IDs, answers, review histories and an exact old-course backup', async () => {
    const { root, state, task, draft } = await seed();
    const result = await applyConcepts(root, draft.id, [{ id: 'c_sem_explicit', name: '显式记忆（检索）' }]);
    expect(result.rebound).toBe(1);
    const next = (await loadTaskPool(root))[0]!;
    expect(next).toEqual({ ...task, concept_id: 'c_sem_explicit' });
    expect((await loadSyllabus(root)).chapters[0]!.concepts[0]!.name).toBe('显式记忆（检索）');
    expect((await loadProgressBoard(join(state, 'progress.md'))).concepts[0]!.mastery).toBe(0);
    expect(await readFile(join(state, 'notes.md'), 'utf8')).toBe('My unchanged notes.');
    const entries = readZip(await readFile(join(state, 'concepts', result.backup)));
    expect(entries.find(entry => entry.path === '.studyclaw/tasks/task_0001.json')?.data.toString()).toContain('"attempts": 5');
    expect(entries.find(entry => entry.path === '.studyclaw/progress.md')?.data.toString()).toContain('90%');
  });

  it('rejects drafts against edited sources and preserves the current course', async () => {
    const { root, state, draft } = await seed();
    const before = await readFile(join(state, 'syllabus.json'));
    await writeFile(join(root, 'paper.md'), 'Changed source.');
    await expect(applyConcepts(root, draft.id, [{ id: 'c_sem_explicit', name: '显式记忆' }])).rejects.toThrow('原文已变化');
    expect(await readFile(join(state, 'syllabus.json'))).toEqual(before);
    expect((await loadTaskPool(root))[0]!.concept_id).toBe('c_old');
  });
  it('indexes raw sources without a model or generating cards before concept confirmation', async () => {
    const { root } = await seed();
    const service = createCourseService(async () => null);
    const result = await service.sync(root, basename(root));
    const jobId = String(result['buildJobId']);
    for (let index = 0; index < 200 && !['done', 'failed'].includes(service.job(jobId)?.status ?? ''); index++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.job(jobId)?.status).toBe('done');
    expect(service.job(jobId)?.result?.tasksGenerated).toBe(0);
    expect((await loadTaskPool(root)).map(task => task.task_id)).toEqual(['h_old']);
  });

  it('syncing adopted knowledge preserves its IDs, definitions and mastery files', async () => {
    const { root, state, draft } = await seed();
    await applyConcepts(root, draft.id, [{ id: 'c_sem_explicit', name: '显式记忆' }]);
    const before = await readFile(join(state, 'syllabus.json'));
    const service = createCourseService(async () => null);
    const result = await service.sync(root, basename(root));
    const jobId = String(result['buildJobId']);
    for (let index = 0; index < 200 && !['done', 'failed'].includes(service.job(jobId)?.status ?? ''); index++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.job(jobId)?.status).toBe('done');
    expect(await readFile(join(state, 'syllabus.json'))).toEqual(before);
    expect((await loadSyllabus(root)).chapters[0]!.concepts[0]!.definition).toBeTruthy();
  });

});
