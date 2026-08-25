/**
 * `studyclaw quiz` 命令测试（对齐 Python test_cli_quiz 断言语义）：
 * Q 序号/[HIT]/[MISS]/PASSED/FAILED/得分/EF/下次复习/结算表头；空作答短路
 * 不触发评测；review 到期清空与 new 空池提示；多课程菜单；非法 mode。
 */

import { describe, expect, it } from 'vitest'
import { UsageError } from '../src/lib/args.ts'
import { quizCommand, runQuiz } from '../src/commands/quiz.ts'
import { capture, evalStreamFactory, fakeRpc, quizTask, SINGLE_WORKSPACE, testTerminal, type Capture } from './helpers.ts'

interface QuizDeps {
  rpc: ReturnType<typeof fakeRpc>
  evalStream: ReturnType<typeof evalStreamFactory>['stream']
  terminal: ReturnType<typeof testTerminal>
}

function makeDeps(handlers: Record<string, (payload: unknown) => unknown>, inputs: string[] = [], frames?: Parameters<typeof evalStreamFactory>[0]) {
  const cap = capture()
  const evalFake = evalStreamFactory(frames)
  const deps: QuizDeps = {
    rpc: fakeRpc(handlers),
    evalStream: evalFake.stream,
    terminal: testTerminal(inputs, cap),
  }
  return { deps, cap, evalFake }
}

describe('quiz', () => {
  it('单题全中：渲染 Q 序号、[HIT]、PASSED、得分、EF 与下次复习，并输出结算表', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [quizTask({ question: '什么是 Filter？' })] }),
    }
    const { deps, cap, evalFake } = makeDeps(handlers, ['Filter 负责筛选。'])
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'new', count: 5 })

    const text = cap.text()
    expect(text).toContain('STUDYCLAW // QUIZ')
    expect(text).toContain('Q1/1')
    expect(text).toContain('什么是 Filter？')
    expect(text).toContain('[HIT]')
    expect(text).toContain('√ PASSED')
    expect(text).toContain('得分 100%')
    expect(text).toContain('EF 2.50 → 2.60')
    expect(text).toContain('下次复习 2026-08-25')
    expect(text).toContain('本轮结算')
    expect(text).toContain('通过 1/1')
    expect(text).toContain('progress.md 已原子回写')
    expect(evalFake.calls).toEqual([{ taskId: 't_001', answer: 'Filter 负责筛选。' }])
  })

  it('部分命中：同时渲染 [HIT] 与 [MISS]，未达线为 × FAILED', async () => {
    const frames = [
      { event: 'scan', data: { phase: 'rubric' } },
      { event: 'rubric', data: { index: 0, criterion: '要点一', hit: true } },
      { event: 'rubric', data: { index: 1, criterion: '要点二', hit: false } },
      { event: 'result', data: { score: 0.5, passed: false, feedback: '漏了要点二', misconceptions: ['混淆了概念'] } },
      { event: 'sm2', data: { ef: 2.5, efNew: 2.1, nextReviewAt: '2026-08-25T00:00:00.000Z', masteryDelta: -0.05 } },
      { event: 'done', data: { taskId: 't_001' } },
    ]
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [quizTask()] }),
    }
    const { deps, cap } = makeDeps(handlers, ['不完整的答案'], frames)
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'review', count: 5 })

    const text = cap.text()
    expect(text).toContain('[HIT] 要点一')
    expect(text).toContain('[MISS] 要点二')
    expect(text).toContain('× FAILED')
    expect(text).toContain('得分 50%')
    expect(text).toContain('误区：混淆了概念')
  })

  it('空作答：0 分 × FAILED 本地短路，不触发评测', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [quizTask()] }),
    }
    const { deps, cap, evalFake } = makeDeps(handlers, [''])
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'new', count: 5 })

    const text = cap.text()
    expect(text).toContain('未作答')
    expect(text).toContain('× FAILED')
    expect(evalFake.calls).toEqual([])
    expect(text).toContain('通过 0/1')
  })

  it('review 到期队列清空：黄色提示且可 --mode new 解锁', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [] }),
    }
    const { deps, cap } = makeDeps(handlers)
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'review', count: 5 })
    expect(cap.text()).toContain('今日到期队列已清空')
    expect(cap.text()).toContain('--mode new')
  })

  it('new 模式题卡池为空：提示先 sync 生成题卡', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [] }),
    }
    const { deps, cap } = makeDeps(handlers)
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'new', count: 5 })
    expect(cap.text()).toContain('题卡池为空')
    expect(cap.text()).toContain('studyclaw sync')
  })

  it('多课程：编号菜单选择第二门课', async () => {
    const handlers: Record<string, (payload: unknown) => unknown> = {
      'workspaces.list': () => ({ current: 'D:/ws' }),
      'workspaces.courses': () => ({
        courses: [
          { id: 'c1', title: 'Course One', overallMastery: 0.2, dueToday: 1, lastActiveAt: null },
          { id: 'c2', title: 'Course Two', overallMastery: 0.8, dueToday: 0, lastActiveAt: null },
        ],
        missing: false,
      }),
      'courses.quiz': (payload) => {
        const p = payload as { courseId: string }
        lastQuizCourse = p.courseId
        return { tasks: [quizTask()] }
      },
    }
    let lastQuizCourse = ''
    const { deps, cap } = makeDeps(handlers, ['2', '答案'])
    await runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'new', count: 3 })
    expect(cap.text()).toContain('Course Two')
    expect(lastQuizCourse).toBe('c2')
  })

  it('未打开工作区/无课程：中文 CliError', async () => {
    const noWorkspace = {
      'workspaces.list': () => ({ current: null }),
    }
    const noWorkspaceDeps = makeDeps(noWorkspace)
    await expect(
      runQuiz({ ...noWorkspaceDeps.deps }, { mode: 'new', count: 5 }),
    ).rejects.toMatchObject({ code: 'workspace-not-found' })

    const noCourses = {
      'workspaces.list': () => ({ current: 'D:/ws' }),
      'workspaces.courses': () => ({ courses: [], missing: false }),
    }
    const noCoursesDeps = makeDeps(noCourses)
    await expect(
      runQuiz({ ...noCoursesDeps.deps }, { mode: 'new', count: 5 }),
    ).rejects.toMatchObject({ code: 'course-not-found' })
  })

  it('非法 --mode / 非法题数：UsageError', async () => {
    await expect(quizCommand(['--mode', 'bad'])).rejects.toBeInstanceOf(UsageError)
    await expect(quizCommand(['0'])).rejects.toBeInstanceOf(UsageError)
    // 确保 CLI 入口把 UsageError 记为 exit 2（由 bin.ts main().catch 处理）；此处仅断言类型。
    expect(new UsageError('x').message).toBe('x')
  })

  it('评测失败帧：CliError EVAL_FAILED', async () => {
    const handlers = {
      ...SINGLE_WORKSPACE,
      'courses.quiz': () => ({ tasks: [quizTask()] }),
    }
    const { deps } = makeDeps(handlers, ['答案'], [
      { event: 'scan', data: { phase: 'rubric' } },
      { event: 'error', data: { code: 'EVAL_FAILED', message: 'LLM 未配置' } },
    ] as Parameters<typeof evalStreamFactory>[0])
    await expect(
      runQuiz({ ...deps, terminal: deps.terminal }, { mode: 'new', count: 5 }),
    ).rejects.toMatchObject({ code: 'EVAL_FAILED' })
  })
})
