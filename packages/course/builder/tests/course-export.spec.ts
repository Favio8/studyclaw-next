/**
 * M3 数据可移植性回归：
 * - Markdown 导出可读、计数与源数据一致；
 * - **导出物不含任何凭据**（用测试钉死，不靠"我们没读那个文件"的口头保证）；
 * - 备份→导入往返后状态等价；
 * - 目标已存在默认拒绝、`--force` 明确生效、未知版本拒绝、越界路径拒绝。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPORT_FORMAT_VERSION,
  ImportError,
  createCourseBackup,
  importCourseBackup,
  loadCourseExportData,
  renderCourseMarkdown,
} from '../src/index.ts'
import { readZip } from '../src/zip.ts'
import { writeTaskPool, type HarnessTask } from '../src/index.ts'

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function task(): HarnessTask {
  return {
    task_id: 't_0001',
    concept_id: 'c_sm2',
    source_ref: { file: '讲义.md' },
    type: 'concept',
    difficulty: 3,
    question: 'SM-2 的 EF 如何钳制？',
    options: ['夹在 [1.3, 2.9]', '不钳制'],
    answer_index: 0,
    answer_rationale: '防止极端序列下无限增长。',
    evaluation_criteria: { rubric: ['指出区间', '说明目的'], keywords: ['EF'], misattribution_options: ['概念混淆', '无'] },
    history: { attempts: 2, last_score: 0.8, pass_count: 1, last_review_at: null, next_review_at: '2099-01-01', ef: 2.5 },
    deprecated: false,
    dynamic: false,
    target_id: null,
  }
}

async function course(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-export-'))
  tmpRoots.push(root)
  const dir = join(root, '机器学习')
  const state = join(dir, '.studyclaw')
  await mkdir(join(state, 'tasks'), { recursive: true })
  await mkdir(join(state, 'history'), { recursive: true })
  await writeFile(join(dir, '讲义.md'), '# 讲义\nSM-2 的 EF 夹在 [1.3, 2.9]。', 'utf8')
  await writeFile(join(state, 'syllabus.json'), JSON.stringify({
    course_id: '机器学习', title: '机器学习', version: '1.0.0', granularity: 'fine',
    chapters: [{ id: 'ch1', title: '记忆与复习', description: '间隔重复', concepts: [
      { id: 'c_sm2', name: 'SM-2 算法', type: 'mechanism', prerequisites: [], mastery_score: 0 },
    ] }],
    adjacency: {},
  }), 'utf8')
  await writeFile(join(state, 'progress.md'), [
    '# 学习进度', '',
    '- **总体掌握度**：82%', '- **待复习卡片数**：1', '- **最后更新时间**：2026-10-11 10:00', '',
    '| concept_id | name | chapter | mastery | evals | pass_rate | ef | next_review_at | misattribution | streak | exposure |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    '| `c_sm2` | SM-2 算法 | 记忆与复习 | 🟢 82% | 2 | 100% | 2.60 | 2099-01-01 | none | 2 | 7 |',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(state, 'notes.md'), '我的笔记：EF 上限防止无限增长。\n', 'utf8')
  await writeFile(join(state, 'annotations.json'), JSON.stringify({
    version: 1,
    sources: { '讲义.md': { progress: { page: 1, percent: 10, updatedAt: '2026-10-11T00:00:00.000Z' }, highlights: [
      { id: 'h1', page: 1, rects: [], quote: { text: 'EF 夹在 [1.3, 2.9]', prefix: '', suffix: '' },
        color: 'yellow', comment: '重点', tags: ['复习'], conceptId: 'c_sm2', createdAt: '2026-10-11T00:00:00.000Z' },
    ] } },
  }), 'utf8')
  await writeTaskPool(dir, [task()])
  await writeFile(join(state, 'history', 's1.events.jsonl'), '{"kind":"x"}\n', 'utf8')
  return dir
}

describe('M3 导出', () => {
  it('Markdown 导出：frontmatter 计数与实际一致，含进度/大纲/题卡/标注/笔记', async () => {
    const dir = await course()
    const data = await loadCourseExportData(dir, '机器学习')
    const md = renderCourseMarkdown(data)

    expect(md).toContain(`studyclaw_export: ${EXPORT_FORMAT_VERSION}`)
    expect(md).toContain('course_id: 机器学习')
    expect(md).toContain('concept_count: 1')
    expect(md).toContain('task_count: 1')
    expect(md).toContain('annotation_count: 1')
    expect(md).toContain('🟢 82%')
    expect(md).toContain('| 7 |')          // exposure 进入导出
    expect(md).toContain('SM-2 算法')
    expect(md).toContain('正确答案：夹在 [1.3, 2.9]')
    expect(md).toContain('采分点：指出区间')
    expect(md).toContain('EF 夹在 [1.3, 2.9]')
    expect(md).toContain('我的笔记：EF 上限防止无限增长。')
  })

  it('题目里的竖线不破坏表格（单元格转义）', async () => {
    const dir = await course()
    const data = await loadCourseExportData(dir, '机器学习')
    const escaped = renderCourseMarkdown({ ...data, tasks: [{ ...task(), concept_id: 'a|b' }] })
    expect(escaped).toContain('a\\|b')
  })

  it('课程尚未构建时导出仍可用（不抛错，给出占位说明）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyclaw-empty-'))
    tmpRoots.push(root)
    const dir = join(root, '空课程')
    await mkdir(join(dir, '.studyclaw'), { recursive: true })
    const md = renderCourseMarkdown(await loadCourseExportData(dir, '空课程'))
    expect(md).toContain('course_id: 空课程')
    expect(md).toContain('_暂无大纲')
    expect(md).toContain('_暂无题卡')
  })

  it('备份归档不含任何凭据类文件', async () => {
    const dir = await course()
    const state = join(dir, '.studyclaw')
    // 就地放几份绝不该出现在导出物里的东西
    await writeFile(join(state, 'config.yaml'), 'apiKey: sk-should-never-leak\ntoken: t-leak\n', 'utf8')
    await mkdir(join(state, 'credentials'), { recursive: true })
    await writeFile(join(state, 'credentials', 'deepseek.json'), '{"apiKey":"sk-leak"}', 'utf8')
    await writeFile(join(state, 'master.key'), 'PRIVATE-KEY-MATERIAL', 'utf8')

    const backup = await createCourseBackup(dir)
    // Inspect decompressed contents: compressed secret bytes evade raw ZIP searches.
    const entries = readZip(backup)
    const text = entries.map(entry => `${entry.path}\n${entry.data.toString('utf8')}`).join('\n')
    for (const secret of ['sk-should-never-leak', 'sk-leak', 'PRIVATE-KEY-MATERIAL', 't-leak']) {
      expect(text).not.toContain(secret)
    }
  })

  it('备份包含完整状态文件（可完整还原）', async () => {
    const dir = await course()
    const backup = await createCourseBackup(dir)
    const { readZip } = await import('../src/zip.ts')
    const paths = readZip(backup).map(entry => entry.path)
    expect(paths).toContain('studyclaw-export.json')
    // 归档保留 `.studyclaw/` 前缀，导入才能还原出原始布局。
    expect(paths).toContain('.studyclaw/syllabus.json')
    expect(paths).toContain('.studyclaw/progress.md')
    expect(paths).toContain('.studyclaw/notes.md')
    expect(paths).toContain('.studyclaw/annotations.json')
    expect(paths).toContain('.studyclaw/tasks/task_0001.json')
    expect(paths).toContain('.studyclaw/history/s1.events.jsonl')
  })
})

describe('M3 导入', () => {
  it('备份→导入往返：进度与标注解析结果等价', async () => {
    const dir = await course()
    const backup = await createCourseBackup(dir)
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)

    const result = await importCourseBackup(backup, target)
    expect(result.courseId).toBe('机器学习')
    const restoredDir = join(target, '机器学习', '.studyclaw')
    expect(await readFile(join(restoredDir, 'progress.md'), 'utf8')).toBe(await readFile(join(dir, '.studyclaw', 'progress.md'), 'utf8'))
    expect(await readFile(join(restoredDir, 'annotations.json'), 'utf8')).toBe(await readFile(join(dir, '.studyclaw', 'annotations.json'), 'utf8'))
    expect(await readFile(join(restoredDir, 'tasks', 'task_0001.json'), 'utf8')).toBe(await readFile(join(dir, '.studyclaw', 'tasks', 'task_0001.json'), 'utf8'))
  })

  it('目标已存在时默认拒绝，绝不覆盖学习数据', async () => {
    const dir = await course()
    const backup = await createCourseBackup(dir)
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    const existing = join(target, '机器学习', '.studyclaw')
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, 'progress.md'), '我自己的学习数据', 'utf8')

    await expect(importCourseBackup(backup, target)).rejects.toBeInstanceOf(ImportError)
    // 原数据分毫未动。
    expect(await readFile(join(existing, 'progress.md'), 'utf8')).toBe('我自己的学习数据')
  })

  it('--force 明确生效：还原到已存在目标', async () => {
    const dir = await course()
    const backup = await createCourseBackup(dir)
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    await mkdir(join(target, '机器学习', '.studyclaw'), { recursive: true })

    await importCourseBackup(backup, target, { force: true })
    expect(await readFile(join(target, '机器学习', '.studyclaw', 'progress.md'), 'utf8')).toContain('c_sm2')
  })

  it('未知版本拒绝导入并给出可读错误', async () => {
    const { createZip } = await import('../src/zip.ts')
    const archive = createZip([{ path: 'studyclaw-export.json', data: Buffer.from(JSON.stringify({ studyclaw_export: 999, course_id: 'x' })) }])
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    await expect(importCourseBackup(archive, target)).rejects.toThrow(/备份版本不受支持/)
  })

  it('非 StudyClaw 归档被拒绝', async () => {
    const { createZip } = await import('../src/zip.ts')
    const archive = createZip([{ path: 'random.txt', data: Buffer.from('hello') }])
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    await expect(importCourseBackup(archive, target)).rejects.toThrow(/缺少 studyclaw-export.json/)
    await expect(importCourseBackup(Buffer.from('not a zip'), target)).rejects.toThrow(/无法解析/)
  })

  it('归档中的越界路径被拒绝（解压逃逸防护）', async () => {
    const { createZip } = await import('../src/zip.ts')
    const archive = createZip([
      { path: 'studyclaw-export.json', data: Buffer.from(JSON.stringify({ studyclaw_export: EXPORT_FORMAT_VERSION, course_id: 'ok' })) },
      { path: '../../escaped.txt', data: Buffer.from('pwned') },
    ])
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    await expect(importCourseBackup(archive, target)).rejects.toThrow(/越界路径/)
  })

  it('course_id 是非法目录名时拒绝', async () => {
    const { createZip } = await import('../src/zip.ts')
    const archive = createZip([{ path: 'studyclaw-export.json', data: Buffer.from(JSON.stringify({ studyclaw_export: EXPORT_FORMAT_VERSION, course_id: '../evil' })) }])
    const target = await mkdtemp(join(tmpdir(), 'studyclaw-import-'))
    tmpRoots.push(target)
    await expect(importCourseBackup(archive, target)).rejects.toThrow(/不是合法目录名/)
  })
})
