import { afterEach, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceDocument } from '../src/source-document.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function pdf(path: string, second: string) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Memory for language models', { x: 50, y: 650, size: 16, font });
  doc.addPage().drawText(second, { x: 50, y: 650, size: 12, font });
  await writeFile(path, await doc.save());
}
it('extracts true PDF page references and invalidates structured cache after source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studyclaw-pdf-source-')); roots.push(root);
  const path = join(root, 'paper.pdf'); await pdf(path, 'Explicit memory retrieves external records.');
  const original = await readFile(path);
  const document = await readSourceDocument(path, 'paper.pdf', join(root, '.studyclaw'));
  expect(document.pages).toBe(2);
  expect(document.blocks.find(block => block.text.includes('external records'))?.page).toBe(2);
  expect(await readFile(path)).toEqual(original);
  expect(await readSourceDocument(path, 'paper.pdf', join(root, '.studyclaw'))).toEqual({ ...document, blocks: document.blocks.map(block => ({ ...block, bbox: null })) });
  await pdf(path, 'Online memory changes during interaction.');
  const changed = await readSourceDocument(path, 'paper.pdf', join(root, '.studyclaw'));
  expect(changed.sha256).not.toBe(document.sha256);
  expect(changed.blocks.find(block => block.page === 2)?.text).toContain('Online memory changes');
  expect(changed.blocks.some(block => block.text.includes('external records'))).toBe(false);
});
