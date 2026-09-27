/**
 * pickTasks 选卡语义（Python `QuizEngine._select` parity）：
 * review = 到期优先 + 未评测（attempts=0）新卡补位；dueOnly（review 命令）
 * 只出到期卡不补位；排序 attempts 升序优先；new 模式反选到期概念；
 * concept 聚焦忽略到期语义；count 截断。
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProgressBoard, saveProgressBoard, upsertProgressRecord, writeTaskPool } from '@studyclaw/course-builder'
import type { HarnessTask } from '@studyclaw/course-builder'
import { pickTasks } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * 构造测试课程。FL-24 之后「是否已评测」的唯一事实源是 `progress.md`
 * （`evalSubmit` 只写它，从不回写 task pool），所以要用进度板而不是
 * `task.history.attempts` 来表达"这个概念练过几次"。
 * @param cEvals - 概念 c_c 的评测次数（进度板口径）。
 */
async function makeCourse(cEvals = 0): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-pick-'))
  tmpRoots.push(root)
  const course = join(root, 'demo')
  await mkdir(join(course, '.studyclaw'), { recursive: true })
  // 进度板：c_a 已到期（昨日），c_b/c_c 为新播种概念（nextReviewAt=null）。
  // P1-7：板与写入侧一致，存放在 <课程根>/.studyclaw/progress.md。
  let board = {
    overallMastery: 0,
    dueCount: 0,
    lastUpdatedAt: '2026-08-20 10:00',
    concepts: [] as Awaited<ReturnType<typeof loadProgressBoard>>['concepts'],
  }
  board = upsertProgressRecord(board, {
    conceptId: 'c_a', name: '概念A', chapter: '章一', mastery: 0.6, evals: 1,
    passRate: 0.5, streak: 1, ef: 2.5, nextReviewAt: '2026-08-20', misattribution: 'none',
  })
  board = upsertProgressRecord(board, {
    conceptId: 'c_b', name: '概念B', chapter: '章一', mastery: 0, evals: 0,
    passRate: 0, streak: 0, ef: 2.5, nextReviewAt: null, misattribution: 'none',
  })
  board = upsertProgressRecord(board, {
    conceptId: 'c_c', name: '概念C', chapter: '章一', mastery: 0, evals: cEvals,
    passRate: 0, streak: 0, ef: 2.5, nextReviewAt: null, misattribution: 'none',
  })
  await saveProgressBoard(join(course, '.studyclaw', 'progress.md'), board)
  return course
}

function makeTask(taskId: string, conceptId: string, attempts: number, difficulty = 2): HarnessTask {
  return {
    task_id: taskId,
    concept_id: conceptId,
    source_ref: { file: 'overview.md', chunk_id: 'chunk_001', line_range: [1, 10] },
    type: 'concept',
    difficulty,
    question: `${conceptId} 考题`,
    options: null,
    evaluation_criteria: { rubric: ['要点一', '要点二'], keywords: [conceptId] },
    history: { attempts, last_score: null, pass_count: 0, last_review_at: null, next_review_at: null, ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
  }
}

describe('pickTasks', () => {
  // T-4：同 (attempts, difficulty) 内随机洗牌；并列顺序断言传确定性 rng
  // （常量 → 抖动全相等 → 稳定排序保持写入序）。
  const fixedRng = (): number => 0.5

  it('review：到期概念优先，到期不足时用未评测新卡补位', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 5),
      makeTask('t_b01', 'c_b', 0),
      makeTask('t_c01', 'c_c', 0),
    ])
    const picked = await pickTasks(course, 'review', null, 3, '2026-08-21', false, fixedRng)
    expect(picked.map(task => task.task_id)).toEqual(['t_a01', 't_b01', 't_c01'])
  })

  it('review 补位：attempts 升序先出，且每概念只补一张（Python parity）', async () => {
    // c_c 在进度板里已评测 3 次，不应被当成"未评测新卡"补位。
    const course = await makeCourse(3)
    await writeTaskPool(course, [
      makeTask('t_b01', 'c_b', 0),
      makeTask('t_d01', 'c_b', 0, 3), // 同概念第二卡：补位按概念去重，不应出现
      makeTask('t_c01', 'c_c', 3),
    ])
    const picked = await pickTasks(course, 'review', null, 2, '2026-08-21')
    // 无到期卡 → 全部来自补位；attempts=0 优先，同概念只补一张。
    expect(picked.map(task => task.task_id)).toEqual(['t_b01'])
  })

  it('FL-24 回归：选题只认 progress.md，忽略恒为 0 的 task.history.attempts', async () => {
    // c_c 在进度板里已评测 3 次，但 task 的 history 谎报 0 次（真实场景里
    // history 恒为生成时的 0，因为评测从不回写 task pool）。旧实现会把所有
    // 练过的卡都当新卡补进复习队列；新实现以进度板为准，c_c 不应被补位。
    const course = await makeCourse(3)
    await writeTaskPool(course, [
      makeTask('t_b01', 'c_b', 0),
      makeTask('t_c01', 'c_c', 0), // history 谎报"未评测"
    ])
    const picked = await pickTasks(course, 'review', null, 2, '2026-08-21')
    expect(picked.map(task => task.task_id)).toEqual(['t_b01'])
  })

  it('FL-24 回归：到期卡按进度板的真实评测次数升序出卡', async () => {
    const course = await makeCourse()
    // 让 c_c 也到期，且评测次数（5）多于 c_a（1）。
    const boardPath = join(course, '.studyclaw', 'progress.md')
    let board = await loadProgressBoard(boardPath)
    board = upsertProgressRecord(board, {
      conceptId: 'c_c', name: '概念C', chapter: '章一', mastery: 0.4, evals: 5,
      passRate: 0.4, streak: 0, ef: 2.5, nextReviewAt: '2026-08-19', misattribution: 'none',
    })
    await saveProgressBoard(boardPath, board)
    await writeTaskPool(course, [
      // 两张卡的 history.attempts 都是 0（真实场景里评测从不回写 task pool），
      // 且难度相同，因此若实现仍读 history 就会退化成按 task_id 排序 →
      // 't_a00' 先于 't_a01'；按进度板的真实次数则 c_a(1) 应先于 c_c(5)。
      makeTask('t_a00', 'c_c', 0),
      makeTask('t_a01', 'c_a', 0),
    ])
    const picked = await pickTasks(course, 'review', null, 2, '2026-08-21')
    expect(picked.map(task => task.task_id)).toEqual(['t_a01', 't_a00'])
  })

  it('dueOnly：只出到期卡，不补新卡（review 命令语义）', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 5),
      makeTask('t_b01', 'c_b', 0),
    ])
    const picked = await pickTasks(course, 'review', null, 3, '2026-08-21', true)
    expect(picked.map(task => task.task_id)).toEqual(['t_a01'])
  })

  it('new：反选到期概念，未到期概念卡正常挑选', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 1),
      makeTask('t_b01', 'c_b', 0),
    ])
    const picked = await pickTasks(course, 'new', null, 5, '2026-08-21')
    expect(picked.map(task => task.concept_id)).not.toContain('c_a')
    expect(picked.map(task => task.task_id)).toEqual(['t_b01'])
  })

  it('concept 聚焦：忽略到期语义，直接出目标概念卡', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 5),
      makeTask('t_c01', 'c_c', 0),
    ])
    const picked = await pickTasks(course, 'review', 'c_c', 5, '2026-08-21')
    expect(picked.map(task => task.task_id)).toEqual(['t_c01'])
  })

  it('count 截断与 deprecated 过滤', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 5),
      makeTask('t_b01', 'c_b', 0),
      { ...makeTask('t_z01', 'c_b', 0, 5), deprecated: true },
    ])
    const picked = await pickTasks(course, 'review', null, 1, '2026-08-21')
    expect(picked.map(task => task.task_id)).toEqual(['t_a01'])
  })

  it('T-4：到期挑选按概念去重（count 内不全是同一概念），不足时同概念补位', async () => {
    const course = await makeCourse()
    // 让 c_a 与 c_c 都到期；c_a 有两张到期卡。
    const boardPath = join(course, '.studyclaw', 'progress.md')
    let board = await loadProgressBoard(boardPath)
    board = upsertProgressRecord(board, {
      conceptId: 'c_c', name: '概念C', chapter: '章一', mastery: 0.4, evals: 5,
      passRate: 0.4, streak: 0, ef: 2.5, nextReviewAt: '2026-08-19', misattribution: 'none',
    })
    await saveProgressBoard(boardPath, board)
    await writeTaskPool(course, [
      makeTask('t_a01', 'c_a', 1),
      makeTask('t_a02', 'c_a', 1), // 同概念第二张到期卡
      makeTask('t_c01', 'c_c', 5),
    ])
    // count=2：两概念各一张（旧实现会给出同一概念的两张）。
    const spread = await pickTasks(course, 'review', null, 2, '2026-08-21', false, fixedRng)
    expect(spread.map(task => task.task_id)).toEqual(['t_a01', 't_c01'])
    // count=3：概念去重后不足，用同概念其余到期卡补位（不少题）。
    const topped = await pickTasks(course, 'review', null, 3, '2026-08-21', false, fixedRng)
    expect(topped.map(task => task.task_id)).toEqual(['t_a01', 't_c01', 't_a02'])
  })

  it('T-4：同排序键内随机洗牌（确定性 rng 保序，递次 rng 改变并列顺序）', async () => {
    const course = await makeCourse()
    await writeTaskPool(course, [
      makeTask('t_x01', 'c_x', 0),
      makeTask('t_x02', 'c_x', 0),
      makeTask('t_x03', 'c_x', 0),
    ])
    // 概念聚焦路径不受 due/补位逻辑影响，ordered 即 (attempts,difficulty,jitter)
    // 全序；常量 rng → 抖动全相等 → 稳定排序保持写入序。
    const fixed = await pickTasks(course, 'review', 'c_x', 3, '2026-08-21', false, () => 0.5)
    expect(fixed.map(task => task.task_id)).toEqual(['t_x01', 't_x02', 't_x03'])
    // 递次 rng（3,2,1 按池序分配）→ 抖动升序即池序倒置。
    let n = 3
    const descRng = (): number => n--;
    const shuffled = await pickTasks(course, 'review', 'c_x', 3, '2026-08-21', false, descRng)
    expect(shuffled.map(task => task.task_id)).toEqual(['t_x03', 't_x02', 't_x01'])
  })
})
