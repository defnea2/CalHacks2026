import { describe, expect, it } from 'vitest';
import { documentKind, MAX_DOC_CHARS, readClassDocument } from '../src/lib/classDocument';

describe('class document (teacher material)', () => {
  it('accepts images, Markdown and plain text', () => {
    expect(documentKind('sheet.png', 'image/png')).toBe('image');
    expect(documentKind('photo.HEIC', 'image/heic')).toBe('image');
    expect(documentKind('plan.md', '')).toBe('markdown');
    expect(documentKind('plan.markdown', 'text/x-markdown')).toBe('markdown');
    expect(documentKind('notes.txt', '')).toBe('text');
    expect(documentKind('notes', 'text/plain')).toBe('text');
    expect(documentKind('slides.pdf', 'application/pdf')).toBeNull();
  });

  it('reads Markdown as text and cuts it to the module limit', async () => {
    const long = new File(['# Plan\n' + 'x'.repeat(MAX_DOC_CHARS + 10)], 'plan.md', { type: 'text/markdown' });
    const d = await readClassDocument(long, 1_000_000, 1600);
    expect(d.mime).toBe('text/markdown');
    expect(d.text.length).toBe(MAX_DOC_CHARS);
    expect(d.data.length).toBe(0);
    expect(d.note).toMatch(/cut to/);
    const txt = await readClassDocument(new File(['hello'], 'a.txt'), 1_000_000, 1600);
    expect(txt).toMatchObject({ mime: 'text/plain', text: 'hello', name: 'a.txt' });
  });

  it('rejects other formats', async () => {
    await expect(readClassDocument(new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }), 1, 1)).rejects.toThrow(/image|Markdown/);
  });
});
