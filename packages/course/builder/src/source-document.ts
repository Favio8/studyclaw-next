import { stat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { renameWithRetry } from '@studyclaw/fs-atomic';
import { courseDataDirectory } from './data-directory.ts';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { officePreview } from './document-preview.ts';
import { documentKind } from './formats.ts';
import { extractSourceText } from './extract.ts';
import { parseDocumentWithMineru } from './mineru.ts';

export interface SourceBlock { id: string; source: string; page: number; text: string; bbox?: [number, number, number, number] | null }
export interface SourceDocument { source: string; sha256: string; pages: number; blocks: SourceBlock[] }

/** Page references come from the exact PDF displayed in the reader, including Office previews. */
export async function readSourceDocument(path: string, source: string, stateDir: string): Promise<SourceDocument> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('资料必须是 64 MiB 以内的文件');
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const dir = await courseDataDirectory(join(stateDir, '..'), 'parsed');
  const cache = join(dir, `${sha256}-structure-v1.json`);
  const existing = await realpath(cache).catch(() => null);
  if (existing) {
    const rel = relative(dir, existing);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('结构化缓存不能通过链接越界');
    const raw = await readFile(existing, 'utf8');
    const schema = z.object({ sha256: z.literal(sha256), source: z.string(), pages: z.number().int().min(1), blocks: z.array(z.object({ id: z.string(), source: z.string(), page: z.number().int().min(1), text: z.string(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional() })) });
    let parsed: z.infer<typeof schema> | null = null;
    try { parsed = schema.parse(JSON.parse(raw)); } catch { /* Derived cache can be rebuilt from its source. */ }
    if (parsed) return { ...parsed, source, blocks: parsed.blocks.map(block => ({ ...block, source, bbox: block.bbox ?? null })) };
  }
  const kind = documentKind(path);
  if (kind === 'image') return ocr(path);
  let pages: Array<{ num: number; text: string }>;
  if (kind === 'pdf' || kind === 'office') {
    const preview = kind === 'office' ? await officePreview(path, stateDir) : path;
    const parser = new PDFParse({ data: await readFile(preview) });
    try { pages = (await parser.getText()).pages; } finally { await parser.destroy(); }
    if (pages.every(page => page.text.replace(/-- \d+ of \d+ --/g, '').trim() === '')) return ocr(preview);
  } else {
    const extension = /\.[^.]+$/.exec(path)?.[0].toLowerCase() ?? '';
    pages = [{ num: 1, text: await extractSourceText(path, extension) }];
  }
  const blocks: SourceBlock[] = [];
  for (const page of pages) {
    const text = page.text.replace(/-- \d+ of \d+ --/g, '').trim();
    for (let offset = 0, index = 0; offset < text.length; offset += 4000, index++) {
      const content = text.slice(offset, offset + 4000);
      blocks.push({ id: `${sha256.slice(0, 12)}_p${page.num}_b${index}`, source, page: page.num, text: content });
    }
  }
  // Also anchors text/HTML/image OCR selections; the original image remains immediately viewable.
  return persist({ source, sha256, pages: pages.length, blocks });

  async function persist(document: SourceDocument): Promise<SourceDocument> {
    const temp = `${cache}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(document), { flag: 'wx' });
    await renameWithRetry(temp, cache);
    return document;
  }

  async function ocr(target: string): Promise<SourceDocument> {
    const parsed = await parseDocumentWithMineru(target);
    if (!parsed.length) throw new Error('OCR 未识别出正文');
    return persist({ source, sha256, pages: Math.max(...parsed.map(block => block.page)), blocks: parsed.map((block, index) => ({ ...block, source, id: `${sha256.slice(0, 12)}_p${block.page}_b${index}` })) });
  }
}
