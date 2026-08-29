/**
 * `studyclaw sync` — trigger an incremental course build (`courses.sync` →
 * async build job) and poll `jobs.get` until done/failed, printing N/M
 * progress. FL-13/FL-14：此前 CLI 没有任何可触发构建的命令，quiz 的空池提示
 * 「请先运行 studyclaw sync」指向一个不存在的命令（死链指引）——本命令补上
 * 该缺口，使提示链真实可行。
 * @module @studyclaw/cli/commands/sync
 */

import { hostRpc, type RpcFn } from '../lib/client.ts'
import { makeTerminal, type Terminal } from '../lib/terminal.ts'
import { parseArgs, UsageError } from '../lib/args.ts'
import { resolveCourse } from './course.ts'

export interface SyncDeps {
  rpc: RpcFn
  terminal: Terminal
}

export interface SyncOptions {
  courseId?: string | null
}

interface SyncResult {
  buildJobId: string | null
}

interface JobView {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress?: { total: number; finished: number; currentFile: string | null }
  result?: { syllabusVersion: string; tasksGenerated: number; degraded?: string[] } | null
  error?: string | null
}

export async function runSync(deps: SyncDeps, options: SyncOptions): Promise<void> {
  const { terminal: t, rpc } = deps
  const course = await resolveCourse(deps, options.courseId ?? null)
  t.title('SYNC')
  t.line(`${t.dim('课程')} ${course.title}（${course.id}）`)
  const result = await rpc<SyncResult>('courses.sync', { courseId: course.id })
  if (result.buildJobId === null) {
    t.warn('构建任务未能启动：请检查模型配置（设置 → 模型配置，需已激活供应商与默认模型）')
    return
  }
  t.line(`${t.dim('任务')} ${result.buildJobId} · ${t.dim('轮询进度中…')}`)
  const jobId = result.buildJobId
  let lastProgress = ''
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    const job = await rpc<JobView>('jobs.get', { jobId })
    if (job.status === 'done') {
      t.blank()
      const generated = job.result?.tasksGenerated ?? 0
      t.line(`${t.green('✓')} 构建完成（syllabus ${job.result?.syllabusVersion ?? '-'}，本次生成 ${generated} 张题卡）`)
      const degraded = job.result?.degraded ?? []
      if (degraded.length > 0) {
        t.warn(`构建降级（部分资料未摄取/题卡被质量闸拦截）：`)
        for (const item of degraded) t.line(`  · ${item}`)
      }
      return
    }
    if (job.status === 'failed') {
      throw new UsageError(`构建失败：${job.error ?? '未知错误'}`)
    }
    const p = job.progress
    if (p !== undefined && p.total > 0) {
      const file = p.currentFile ? `（${p.currentFile}）` : ''
      const msg = `${p.finished}/${p.total}${file}`
      if (msg !== lastProgress) {
        lastProgress = msg
        t.line(`${t.dim('进度')} ${msg}`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new UsageError('构建超时（30 分钟仍未完成）')
}

/** CLI 入口：`studyclaw sync [--course <id>]`。 */
export async function syncCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  await runSync(
    { rpc: hostRpc, terminal: makeTerminal() },
    { courseId: parsed.options.course === undefined ? null : String(parsed.options.course) },
  )
}
