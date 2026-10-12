/**
 * M3 数据可移植性的 CLI 入口：
 *
 * - `studyclaw export <course> [--format markdown|backup] [--out <路径>]`
 *   markdown = 人读迁移（可投喂 Obsidian、可邮件传输）；backup = 完整归档（供 import 还原）。
 * - `studyclaw import <归档路径> [--course-id <id>] [--force]`
 *
 * 产物字节由 Host 生成（路径裁决权在 Host），本命令只负责落盘与呈现。
 * @module @studyclaw/cli/commands/transfer
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CliError, hostBinary, hostDownload } from '../lib/client.ts'
import { makeTerminal } from '../lib/terminal.ts'
import { optionValue, parseArgs, UsageError } from '../lib/args.ts'
import { makeCourseDeps, resolveCourse } from './course.ts'

export async function exportCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const deps = makeCourseDeps()
  const { terminal } = deps
  const explicit = optionValue(parsed, 'course')
  const formatArg = optionValue(parsed, 'format', 'markdown')
  if (formatArg !== 'markdown' && formatArg !== 'backup') {
    throw new UsageError(`--format 只支持 markdown 或 backup（收到「${formatArg}」）`)
  }
  const course = await resolveCourse(deps, explicit)

  // 走二进制通道：JSON+base64 撑不住大课程（见 client.hostDownload 注释）。
  const bytes = await hostDownload(
    `/api/courses.export?courseId=${encodeURIComponent(course.id)}&format=${formatArg}`)
  const out = optionValue(parsed, 'out')
  const stamp = new Date().toISOString().slice(0, 10)
  const fallback = formatArg === 'markdown' ? `${course.id}-${stamp}.md` : `${course.id}-${stamp}.studyclaw.zip`
  const target = resolve(out ?? fallback)
  await writeFile(target, bytes)

  terminal.line(`已导出 ${terminal.bold(course.title)}（${course.id}）`)
  terminal.line(`  格式    ${formatArg === 'markdown' ? 'Markdown（人读，可迁移）' : '完整归档（可还原）'}`)
  terminal.line(`  文件    ${target}`)
  terminal.line(`  大小    ${(bytes.length / 1024).toFixed(1)} KB`)
  if (formatArg === 'markdown') {
    terminal.line('  还原    Markdown 仅供阅读；要完整还原请用 backup 归档 + studyclaw import')
  }
}

export async function importCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const terminal = makeTerminal()
  const source = parsed.positionals[0]
  if (source === undefined || source === '') {
    throw new UsageError('用法：studyclaw import <备份.zip> [--course-id <id>] [--force]')
  }
  const force = parsed.options['force'] === true
  const courseId = optionValue(parsed, 'course-id', '')

  try {
    const body = await readFile(resolve(source))
    const query = new URLSearchParams()
    if (courseId !== null && courseId !== '') query.set('courseId', courseId)
    if (force) query.set('force', '1')
    const suffix = query.toString()
    const result = await hostBinary<{ courseId: string; files: number }>(
      `/api/courses.import${suffix === '' ? '' : `?${suffix}`}`,
      { method: 'POST', body },
    )
    terminal.line(`已还原课程 ${terminal.bold(result.courseId)}（${result.files} 个文件）`)
    if (!force) terminal.line('  提示    如需覆盖同名课程，追加 --force')
  } catch (error) {
    // 还原失败必须给出可操作的说明，不能把栈直接甩给用户。
    if (error instanceof CliError) throw error
    throw new CliError('import-failed', error instanceof Error ? error.message : String(error))
  }
}
