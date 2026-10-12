import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renameWithRetry } from '@studyclaw/fs-atomic';
import { courseDataDirectory } from './data-directory.ts';
import { documentKind } from './formats.ts';

const run = promisify(execFile);
const pending = new Map<string, Promise<string>>();

export async function officePreview(source: string, stateDir: string): Promise<string> {
  if (documentKind(source) !== 'office') return source;
  const bytes = await readFile(source);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = await courseDataDirectory(join(stateDir, '..'), 'previews');
  const target = join(dir, `${hash}-libreoffice.pdf`);
  if ((await stat(target).catch(() => null))?.isFile()) {
    if (await realpath(target) !== target) throw new Error('预览文件不能是链接');
    return target;
  }
  const key = target;
  if (!pending.has(key)) pending.set(key, convert());
  try { return await pending.get(key)!; } finally { pending.delete(key); }

  async function convert(): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'studyclaw-office-'));
    try {
      const executable = process.env['STUDYCLAW_SOFFICE'] || (process.platform === 'win32' ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : 'soffice');
      await run(executable, [`-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', work, source], { timeout: 120000, windowsHide: true });
      const output = join(work, `${basename(source, extname(source))}.pdf`);
      const pdf = await readFile(output);
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Office 转换未产出有效 PDF');
      const temp = join(dir, `.preview-${randomUUID()}.tmp`);
      await writeFile(temp, pdf, { flag: 'wx' });
      await renameWithRetry(temp, target);
      return target;
    } catch (error) {
      throw new Error(`Office 预览失败，请安装 LibreOffice，或设置 STUDYCLAW_SOFFICE：${error instanceof Error ? error.message : String(error)}`);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}
