import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { pack } from '@tutor/shared';
import { getRenderer, parseContent, renderers } from '../src/board/registry';
import { revealState, utteranceProgress } from '../src/board/reveal';
import type { RendererProps } from '../src/board/types';

const props = (content: Record<string, unknown>, progress = Infinity): RendererProps => ({
  content,
  reveal: { revealed: true, progress },
  answer: { state: 'open', last: '' },
});

const render = (kind: string, content: Record<string, unknown>, progress = Infinity) => {
  const { renderer } = getRenderer(kind);
  return renderToStaticMarkup(createElement(renderer, { ...props(content, progress), kind } as RendererProps));
};

describe('renderer registry', () => {
  it('has a renderer for every pack board kind (contract)', () => {
    for (const k of pack.boardKinds) expect(getRenderer(k.name).known, k.name).toBe(true);
  });

  it('unknown kind -> neutral fallback with title + raw content, no throw', () => {
    const { known } = getRenderer('hologram');
    expect(known).toBe(false);
    const html = render('hologram', { title: 'A thing', x: 1 });
    expect(html).toContain('board-fallback');
    expect(html).toContain('A thing');
    expect(html).toContain('&quot;x&quot;: 1');
    expect(getRenderer('constructor').known).toBe(false); // no prototype leaks
  });

  it('bad JSON content still renders', () => {
    expect(parseContent('{nope')).toEqual({ raw: '{nope' });
    expect(parseContent('[1]')).toEqual({ value: [1] });
  });

  it('every pack kind renders its placeholder content without throwing', () => {
    const samples: Record<string, unknown>[] = [
      { text: 'Hello' },
      { latex: '\\frac{2}{3} = \\frac{8}{12}', caption: 'same amount' },
      { title: 'Expand', steps: [{ show: '\\frac{3}{5}' }, { show: '\\frac{12}{20}', note: 'times 4' }] },
      { prompt: 'Fill in', latex: '\\frac{1}{2} = \\frac{\\square}{6}', choices: ['2', '3'] },
      { visual: 'fraction_bar', parts: 4, shaded: 3 },
      { visual: 'number_line', min: 0, max: 1, marks: [0, 0.5, 1], highlight: 0.5 },
      { visual: 'area_grid', rows: 3, cols: 4, shaded: 6 },
      { visual: 'groups', groups: 4, perGroup: 3 },
      { visual: 'mystery' },
      {},
    ];
    for (const r of Object.keys(renderers)) for (const c of samples) expect(() => render(r, c)).not.toThrow();
  });

  it('worked steps reveal one per sentence', () => {
    const c = { steps: [{ show: 'a' }, { show: 'b' }, { show: 'c' }] };
    const count = (html: string) => (html.match(/data-testid="worked-step"/g) ?? []).length;
    const ws = Object.keys(renderers).find(k => render(k, c, 1).includes('worked-step'))!;
    expect(count(render(ws, c, 1))).toBe(1);
    expect(count(render(ws, c, 2))).toBe(2);
    expect(count(render(ws, c, Infinity))).toBe(3);
  });
});

describe('reveal sync', () => {
  it('untagged items show immediately', () => {
    expect(revealState({ utteranceId: 0n, sentenceIdx: 0 }, undefined)).toEqual({ revealed: true, progress: Infinity });
  });

  it('tagged items wait for their sentence', () => {
    const item = { utteranceId: 7n, sentenceIdx: 2 };
    expect(revealState(item, undefined).revealed).toBe(false);
    expect(revealState(item, { maxStarted: 1, started: [0, 1], over: false }).revealed).toBe(false);
    expect(revealState(item, { maxStarted: 2, started: [0, 1, 2], over: false })).toEqual({ revealed: true, progress: 1 });
    expect(revealState(item, { maxStarted: 4, started: [0, 1, 2, 3, 4], over: false }).progress).toBe(3);
    expect(revealState(item, { maxStarted: -1, started: [], over: true }).revealed).toBe(false);
  });

  it('progress from sentence statuses and local playback', () => {
    const s = [
      { utteranceId: 7n, idx: 0, status: 'played' },
      { utteranceId: 7n, idx: 1, status: 'ready' },
      { utteranceId: 8n, idx: 0, status: 'played' },
    ];
    const over = (u: bigint) => u === 8n;
    const p = utteranceProgress(s, new Map([['7', [1]]]), over, ['played'], ['played', 'dropped']);
    expect(p.get('7')).toEqual({ maxStarted: 1, started: [0, 1], over: false });
    expect(p.get('8')).toEqual({ maxStarted: 0, started: [0], over: true });
  });
});
