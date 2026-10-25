// Teacher's class document (startClassSession): an image (compressed in the browser to ≤ 1 MB,
// like the task photo) or Markdown / plain text (max 50 000 characters, docs/CLASSROOM.md).
import { compressPhoto } from './photo';

export const MAX_DOC_CHARS = 50_000;
export const DOC_ACCEPT = 'image/*,.md,.markdown,.txt,text/markdown,text/plain';

export type DocKind = 'image' | 'markdown' | 'text';

export function documentKind(name: string, type: string): DocKind | null {
  const n = name.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (/\.(md|markdown)$/.test(n) || type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (/\.txt$/.test(n) || type === 'text/plain') return 'text';
  return null;
}

export interface ClassDocument {
  name: string;
  mime: string;
  text: string;
  data: Uint8Array;
  /** Shown under the file input. */
  note: string;
}

export const NO_DOCUMENT: ClassDocument = { name: '', mime: '', text: '', data: new Uint8Array(), note: '' };

export async function readClassDocument(file: File, maxBytes: number, maxSide: number): Promise<ClassDocument> {
  const kind = documentKind(file.name, file.type);
  if (!kind) throw new Error('Use an image, a Markdown file (.md) or a text file (.txt).');
  if (kind === 'image') {
    const c = await compressPhoto(file, maxBytes, maxSide);
    return { name: file.name, mime: c.mime, text: '', data: c.data, note: `Image, ${Math.round(c.data.length / 1024)} KB after compression` };
  }
  const raw = await file.text();
  const text = raw.slice(0, MAX_DOC_CHARS);
  const cut = raw.length > MAX_DOC_CHARS ? ` (cut to ${MAX_DOC_CHARS.toLocaleString()} characters)` : '';
  return { name: file.name, mime: kind === 'markdown' ? 'text/markdown' : 'text/plain', text, data: new Uint8Array(), note: `${kind === 'markdown' ? 'Markdown' : 'Text'}, ${text.length.toLocaleString()} characters${cut}` };
}
