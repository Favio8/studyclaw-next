import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** New cache directories follow the same course boundary as source and annotation access. */
export async function courseDataDirectory(root: string, name: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const inside = (path: string) => { const rel = relative(canonicalRoot, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  const state = join(canonicalRoot, '.studyclaw');
  const existing = await realpath(state).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing !== null && !inside(existing)) throw new Error('课程状态目录不能通过链接越界');
  if (existing === null) await mkdir(state, { recursive: true });
  const directory = join(existing ?? state, name);
  const prior = await realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (prior !== null && !inside(prior)) throw new Error('课程缓存目录不能通过链接越界');
  if (prior === null) await mkdir(directory, { recursive: true });
  return prior ?? directory;
}
