import { describe, expect, it } from 'vitest';
import { BUBBLE_CAP, bubblesSignature, sessionBubbles, shownSentences, truncateText, type BubbleSentence, type BubbleTurn } from '../src/lib/bubbles';

const st = (idx: number, text: string, at = idx * 1000, intent = ''): BubbleTurn => ({ idx, role: 'student', text, intent, utteranceId: '0', createdAtMs: at });
const tt = (idx: number, utt: string, text: string, at = idx * 1000): BubbleTurn => ({ idx, role: 'tutor', text, intent: '', utteranceId: utt, createdAtMs: at });
const sen = (utt: string, idx: number, display: string, status: string, at = 0): BubbleSentence => ({ utteranceId: utt, idx, display, speech: display, status, createdAtMs: at });

describe('dashboard bubbles', () => {
  it('student left, tutor right, in turn order', () => {
    const b = sessionBubbles(
      [st(0, 'Hi'), tt(1, '7', 'Hello there. Ready?'), st(2, 'yes')],
      [sen('7', 0, 'Hello there.', 'played', 1000), sen('7', 1, 'Ready?', 'played', 1000)]
    );
    expect(b.map(x => [x.who, x.text])).toEqual([
      ['student', 'Hi'],
      ['tutor', 'Hello there. Ready?'],
      ['student', 'yes'],
    ]);
  });

  it('a tutor bubble grows sentence by sentence as sentences are played', () => {
    const turns = [st(0, 'what is 1/4 + 2/4?', 0)];
    const at = (statuses: string[]) => sessionBubbles(turns, statuses.map((s, i) => sen('9', i, `S${i}.`, s, 500)));
    expect(at(['pending', 'pending']).map(x => x.who)).toEqual(['student']);
    expect(at(['ready', 'pending']).at(-1)).toMatchObject({ who: 'tutor', text: 'S0.', live: true });
    expect(at(['played', 'ready']).at(-1)).toMatchObject({ text: 'S0. S1.', live: true });
    expect(at(['played', 'played']).at(-1)).toMatchObject({ text: 'S0. S1.', live: false });
  });

  it('dropped sentences are skipped; a later one is not shown before the current one', () => {
    expect(shownSentences([sen('1', 0, 'a', 'played'), sen('1', 1, 'b', 'dropped')]).shown.map(s => s.display)).toEqual(['a']);
    expect(shownSentences([sen('1', 2, 'c', 'ready'), sen('1', 0, 'a', 'played'), sen('1', 1, 'b', 'pending')]).shown.map(s => s.display)).toEqual(['a']);
  });

  it('a reply in progress (no tutor turn yet) sits after the student turns before its first sentence', () => {
    const b = sessionBubbles([st(0, 'one', 0), tt(1, '3', 'r1', 1000), st(2, 'two', 2000), st(3, 'barge in', 5000)], [sen('3', 0, 'r1', 'played', 1000), sen('4', 0, 'r2', 'ready', 3000)]);
    expect(b.map(x => x.text)).toEqual(['one', 'r1', 'two', 'r2', 'barge in']);
  });

  it('tutor turns without sentences (history) use the turn text; empty student turns are skipped', () => {
    const b = sessionBubbles([st(0, ''), tt(1, '5', 'From history.'), st(2, '[hint]', 2000, 'hint')], [], { label: (t, i) => (t.startsWith('[') ? `asked for a ${i}` : t) });
    expect(b.map(x => [x.who, x.text])).toEqual([
      ['tutor', 'From history.'],
      ['student', 'asked for a hint'],
    ]);
  });

  it(`keeps the newest ${BUBBLE_CAP} bubbles`, () => {
    const turns = Array.from({ length: 20 }, (_, i) => st(i, `m${i}`));
    const b = sessionBubbles(turns, []);
    expect(b).toHaveLength(BUBBLE_CAP);
    expect(b.map(x => x.text)).toEqual(['m14', 'm15', 'm16', 'm17', 'm18', 'm19']);
    expect(sessionBubbles(turns, [], { cap: 2 }).map(x => x.key)).toEqual(['s18', 's19']);
  });

  it('truncates long text at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(80);
    const t = truncateText(long, 40);
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/ …$/);
    expect(truncateText('  short\n text ')).toBe('short text');
    expect(sessionBubbles([st(0, long)], [], { maxChars: 30 })[0]!.text.length).toBeLessThanOrEqual(30);
  });

  it('signature changes only when what is shown changes', () => {
    const a = sessionBubbles([st(0, 'x')], [sen('1', 0, 'y', 'played', 10)]);
    const b = sessionBubbles([st(0, 'x')], [sen('1', 0, 'y', 'played', 10), sen('1', 1, 'z', 'pending', 10)]);
    expect(bubblesSignature(a)).not.toBe(bubblesSignature(b)); // live flag
    expect(bubblesSignature(a)).toBe(bubblesSignature(sessionBubbles([st(0, 'x')], [sen('1', 0, 'y', 'played', 10)])));
  });
});
