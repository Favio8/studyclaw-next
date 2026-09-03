/**
 * Course resolution shared by quiz/review/chat: `--course <id>` takes
 * precedence; otherwise the only course is picked automatically; multiple
 * courses show a numbered menu. Errors are friendly Chinese CliErrors
 * (workspace not opened / no courses / unknown course id).
 * Also hosts the top-level `studyclaw course` command (list/show).
 * @module @studyclaw/cli/commands/course
 */

import { CliError, hostRpc, type RpcFn } from '../lib/client.ts'
import { UsageError } from '../lib/args.ts'
import { makeTerminal, type Terminal } from '../lib/terminal.ts'

export interface CourseSummary {
  id: string
  title: string
  overallMastery: number
  dueToday: number
  lastActiveAt: string | null
}

interface WorkspacesResult {
  current: string | null
}

interface CoursesResult {
  courses: CourseSummary[]
  missing: boolean
}

export async function resolveCourse(deps: CourseDeps, explicitId: string | null): Promise<CourseSummary> {
  const workspaces = await deps.rpc<WorkspacesResult>('workspaces.list', {})
  if (workspaces.current === null || workspaces.current === '') {
    throw new CliError('workspace-not-found', '尚未打开工作区：请先运行 studyclaw serve 并在 Web 界面打开/选择一个工作区')
  }
  const { courses, missing } = await deps.rpc<CoursesResult>('workspaces.courses', { path: workspaces.current })
  if (missing || courses.length === 0) {
    throw new CliError('course-not-found', '当前工作区没有课程：请先创建或导入课程（Web 端「＋ 新项目」/ studyclaw init）')
  }
  if (explicitId !== null) {
    const found = courses.find(course => course.id === explicitId)
    if (found === undefined) {
      throw new CliError('course-not-found', `课程「${explicitId}」不存在；当前可用：${courses.map(course => course.id).join('、')}`)
    }
    return found
  }
  if (courses.length === 1) return courses[0]!

  const { terminal } = deps
  terminal.line('检测到多门课程，请选择：')
  courses.forEach((course, index) => {
    const mastery = Math.round(course.overallMastery * 100)
    terminal.line(`  ${terminal.bold(String(index + 1))}. ${course.title}（${course.id}）· 掌握度 ${mastery}% · 今日到期 ${course.dueToday}`)
  })
  // Loop until a valid pick; empty input cancels.
  while (true) {
    const pick = await terminal.prompt(`> 选择课程 [1-${courses.length}]（回车取消）: `)
    if (pick.trim() === '') throw new CliError('aborted', '已取消')
    const index = Number.parseInt(pick, 10)
    if (Number.isInteger(index) && index >= 1 && index <= courses.length) return courses[index - 1]!
    terminal.error('无效选择，请重新输入')
  }
}

export interface CourseDeps {
  rpc: RpcFn
  terminal: Terminal
}

export function makeCourseDeps(): CourseDeps {
  return { rpc: hostRpc, terminal: makeTerminal() }
}

function renderCourse(terminal: Terminal, course: CourseSummary, detailed: boolean): void {
  const mastery = Math.round(course.overallMastery * 100)
  if (!detailed) {
    terminal.line(`  ${course.id}  ${terminal.bold(course.title)} · 掌握度 ${mastery}% · 今日到期 ${course.dueToday}`)
    return
  }
  terminal.title(`COURSE // ${course.title}`)
  terminal.line(`  ID        ${course.id}`)
  terminal.line(`  掌握度    ${mastery}%`)
  terminal.line(`  今日到期  ${course.dueToday} 张`)
  terminal.line(`  最后活跃  ${course.lastActiveAt ?? '从未'}`)
}

/**
 * `studyclaw course list` — 列出当前工作区的全部课程（ID/标题/掌握度/今日到期）。
 */
export async function courseListCommand(deps: CourseDeps): Promise<void> {
  const workspaces = await deps.rpc<WorkspacesResult>('workspaces.list', {})
  if (workspaces.current === null || workspaces.current === '') {
    throw new CliError('workspace-not-found', '尚未打开工作区：请先运行 studyclaw serve 并在 Web 界面打开/选择一个工作区')
  }
  const { courses, missing } = await deps.rpc<CoursesResult>('workspaces.courses', { path: workspaces.current })
  if (missing || courses.length === 0) {
    throw new CliError('course-not-found', '当前工作区没有课程：请先创建或导入课程（Web 端「＋ 新项目」/ studyclaw sync）')
  }
  deps.terminal.title('COURSES')
  for (const course of courses) renderCourse(deps.terminal, course, false)
  deps.terminal.line(`共 ${courses.length} 门课程`)
}

/**
 * `studyclaw course show [<id>]` — 显示课程概要；省略 id 时多课程走交互选择
 * （复用 quiz/review 的 resolveCourse 语义）。
 */
export async function courseShowCommand(deps: CourseDeps, explicitId: string | null): Promise<void> {
  const course = await resolveCourse(deps, explicitId)
  renderCourse(deps.terminal, course, true)
}

/** `studyclaw course <list|show> [<id>]` 的分发（bin.ts main() 接线）。 */
export async function courseCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'list'
  if (sub === 'list') await courseListCommand(makeCourseDeps())
  else if (sub === 'show') await courseShowCommand(makeCourseDeps(), argv[1] ?? null)
  else throw new UsageError(`未知子命令「${sub}」：用法 studyclaw course <list|show> [<courseId>]`)
}
