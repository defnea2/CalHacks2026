// Keyframes on point: a formalization moment's equation is revealed on the sentence that reads it
// (module splitKeyframes -> client keyframeParts), not together with the picture.
import { describe, expect, it } from 'vitest';
import { BeatCanvasPlayer, latestUtteranceBeats, orderBeats, revealCount } from '../src/lesson/beatPlayer';
import { cueSentenceOffset, splitKeyframes } from '@tutor/visual/teaching/keyframes';

const row = (utteranceId: bigint, idx: number, visual: unknown, narration: string, sentenceIdx = idx) => ({
  id: BigInt(Number(utteranceId) * 10 + idx), sessionId: 1n, utteranceId, idx, visual: JSON.stringify(visual), narration, sentenceIdx, canvasVersion: idx + 1,
});
const array = (rows: number, columns: number, showEquation = false) => ({ cues: [{ id: 'c', atMs: 0, commands: [{ type: 'show_math', visual: { id: 'groups', kind: 'array', title: 'Groups', rows, columns, showEquation } }] }] });

describe('per-sentence keyframes', () => {
  const sentences = ['Here are three rows of four.', 'Three times four equals twelve.'];
  const single = { id: 'math-beat-0', narration: sentences.join(' '), ...array(3, 4, true) };
  const split = splitKeyframes(single as never, sentences);
  const { narration, ...visual } = split;
  const beats = orderBeats([row(5n, 0, visual, narration)]);
  const equation = (p: BeatCanvasPlayer) => (p.director.getSnapshot().canvas.math?.visual as { showEquation?: boolean } | undefined)?.showEquation;
  const at = (started: number[]) => revealCount({ beats, started: new Map([['5', started]]), over: () => false, mode: 'voice', textShown: 0 });

  it('the module split puts the equation into its own cue for the sentence that reads it', () => {
    expect(split.cues.map(c => c.id)).toEqual(['c', 'c-s1']);
    expect(split.cues[1]!.atMs).toBeGreaterThan(0);
    expect(beats.map(b => [b.key, b.sentenceIdx, b.part])).toEqual([
      ['5:0', 0, 0],
      ['5:0:s1', 1, 1],
    ]);
  });

  it('voice: the picture shows with sentence 0, the equation only when sentence 1 starts', () => {
    const p = new BeatCanvasPlayer();
    expect(at([])).toBe(0);
    p.sync(beats, at([0]));
    expect(p.director.getSnapshot().canvas.math?.visual.kind).toBe('array');
    expect(equation(p)).toBe(false);
    p.sync(beats, at([0, 1]));
    expect(equation(p)).toBe(true);
    expect(p.error).toBeNull();
  });

  it('the next beat waits for its own sentence (sentence 2), after both parts', () => {
    const two = orderBeats([row(5n, 0, visual, narration), row(5n, 1, array(4, 4), 'Four rows now.', 2)]);
    const n = (started: number[]) => revealCount({ beats: two, started: new Map([['5', started]]), over: () => false, mode: 'voice', textShown: 0 });
    expect([n([0]), n([0, 1]), n([0, 1, 2])]).toEqual([1, 2, 3]);
  });

  it('text mode: one playback step per beat, its parts show together', () => {
    expect(latestUtteranceBeats(beats)).toHaveLength(1);
    expect(revealCount({ beats, started: new Map(), over: () => false, mode: 'typed', textShown: 1 })).toBe(2);
  });

  it('no split: one sentence, or no equation change', () => {
    expect(splitKeyframes(single as never, sentences.slice(0, 1)).cues).toHaveLength(1);
    expect(splitKeyframes({ id: 'b', narration: 'x', ...array(2, 2) } as never, sentences).cues).toHaveLength(1);
    expect(orderBeats([row(6n, 0, array(2, 2), 'Two rows.')]).map(b => b.part)).toEqual([0]);
    expect(cueSentenceOffset('math-cue-3-s2')).toBe(2);
    expect(cueSentenceOffset('math-cue-3')).toBe(0);
  });
});
