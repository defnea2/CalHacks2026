import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VoiceCanvasContentSchema } from './contracts';
import { SpeechCanvasPlayer, type SpeechCanvasItem } from './SpeechCanvasPlayer';
import schema from '../../../shared/src/lesson/pack/mathCanvas.schema.json';
import { validateJson } from '../../../shared/src/lesson/api';
import type { JsonSchema } from '../../../shared/src/lesson/types';

const content = { title: 'Four rows of eight', moments: [
  { sentenceOffset: 0, visual: { kind: 'array', rows: 4, columns: 8 } },
  { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_array', splitAt: 5 }] } },
  { sentenceOffset: 2, visual: { kind: 'keep' }, interactive: true, showEquation: true },
] };
const item: SpeechCanvasItem = { id: '1', order: 0, utteranceId: '7', sentenceIdx: 1, content };
const heard = (...indices: number[]) => new Map([['7', indices]]);
const visual = (p: SpeechCanvasPlayer) => p.director.getSnapshot().canvas.math?.visual;

describe('speech canvas', () => {
  it('waits for actual audio, changes the same picture, and deduplicates repeated subscriptions', () => {
    const p = new SpeechCanvasPlayer();
    p.sync([item], heard(), false);
    expect(visual(p)).toBeUndefined();
    p.sync([item], heard(1), false);
    expect(visual(p)).toMatchObject({ kind: 'array', splitAt: null, showEquation: false });
    p.sync([item], heard(1, 2), false);
    expect(visual(p)).toMatchObject({ splitAt: 5, showEquation: false });
    const token = p.director.getSnapshot().token;
    p.sync([item], heard(1, 2), false);
    expect(p.director.getSnapshot().token).toBe(token);
    p.sync([item], heard(1, 2, 3), true);
    expect(visual(p)).toMatchObject({ splitAt: 5, showEquation: true, interactive: true });
  });
  it('never jumps over a dropped sentence or reveals unfinished work after interruption', () => {
    const p = new SpeechCanvasPlayer();
    p.sync([item], heard(1, 3), true);
    expect(visual(p)).toMatchObject({ splitAt: null, showEquation: false });
    p.sync([item], heard(1), true);
    expect(visual(p)).toMatchObject({ splitAt: null });
  });
  it('recovers late board arrival but does not rewind newer pictures', () => {
    const p = new SpeechCanvasPlayer();
    p.sync([], heard(1, 2), false);
    p.sync([item], heard(1, 2), false);
    expect(visual(p)).toMatchObject({ splitAt: 5 });
    const newer = { ...item, id: '2', order: 1, utteranceId: '8', content: { title: 'Area', moments: [
      { sentenceOffset: 0, visual: { kind: 'geometry', shape: 'rectangle', width: 3, height: 2 } },
    ] } };
    p.sync([item, newer], new Map([['8', [1]]]), false);
    p.sync([item, newer], heard(1, 2, 3), false);
    expect(visual(p)).toMatchObject({ kind: 'geometry' });
  });
  it('invalid future commands do not leave a partially applied picture', () => {
    const p = new SpeechCanvasPlayer();
    const invalid = structuredClone(content);
    invalid.moments[1].visual = { kind: 'update', changes: [{ type: 'set_array', splitAt: 19 }] };
    p.sync([{ ...item, content: invalid }], heard(1, 2), false);
    expect(p.error).toBeTruthy();
    expect(visual(p)).toBeUndefined();
  });
  it('supports instant local changes after speech, keeps them on duplicate sync, resets on clear', () => {
    const p = new SpeechCanvasPlayer();
    p.sync([item], heard(1, 2, 3), false);
    const scene = p.director.getSnapshot().canvas.math!;
    const action = { eventId: 'change-1', visualId: 'math', revision: scene.revision, change: { type: 'set_array' as const, rows: 5 } };
    expect(p.interact(action)).toBeNull();
    p.sync([item], heard(1, 2, 3), true);
    expect(p.interact(action)).toBeTruthy();
    p.sync([item], heard(1, 2, 3), true);
    expect(visual(p)).toMatchObject({ rows: 5 });
    p.sync([], heard(), false);
    expect(visual(p)).toBeUndefined();
  });
  it('the voice database schema matches the canonical canvas schema', () => {
    expect(schema).toEqual(z.toJSONSchema(VoiceCanvasContentSchema, { io: 'input' }));
    expect(validateJson(schema as unknown as JsonSchema, content)).toEqual([]);
    expect(validateJson(schema as unknown as JsonSchema, { ...content, title: '' })).not.toEqual([]);
    expect(validateJson(schema as unknown as JsonSchema, { title: 'X', moments: [{ sentenceOffset: 0, visual: { kind: 'execute', code: 'bad' } }] })).not.toEqual([]);
  });
});
