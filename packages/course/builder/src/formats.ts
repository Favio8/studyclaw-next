/** Shared import, preview and extraction capabilities. */
export const DOCUMENT_FORMATS = {
  '.md': 'text', '.txt': 'text', '.pdf': 'pdf',
  '.doc': 'office', '.docx': 'office', '.ppt': 'office', '.pptx': 'office',
  '.xlsx': 'parsed', '.html': 'parsed', '.htm': 'parsed',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
} as const;
export const SOURCE_EXTENSIONS = Object.keys(DOCUMENT_FORMATS);
export function documentKind(path: string): 'text' | 'pdf' | 'office' | 'image' | 'parsed' | null {
  const extension = /\.[^.\\/]+$/.exec(path.toLowerCase())?.[0] ?? '';
  return DOCUMENT_FORMATS[extension as keyof typeof DOCUMENT_FORMATS] ?? null;
}
