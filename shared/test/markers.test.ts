import { describe, expect, it } from 'vitest';
import { hasMarkers, markerIds, prepareSentence, stripMarkers } from '../src/markers';
import { normalizeForSpeech } from '../src/normalizer';
import { SentenceChunker } from '../src/chunker';

const at = (speech: string, pos: number) => speech.slice(pos);

describe('prepareSentence', () => {
  it('leaves sentences without markers alone', () => {
    const p = prepareSentence('Two thirds is 2/3.');
    expect(p).toEqual({ display: 'Two thirds is 2/3.', speech: 'Two thirds is two thirds.', markers: [] });
  });

  it('marker in the middle, next to punctuation', () => {
    const p = prepareSentence('Here are two thirds ⟦b1⟧, and here are eight twelfths ⟦b2⟧.');
    expect(p.display).toBe('Here are two thirds, and here are eight twelfths.');
    expect(p.speech).toBe('Here are two thirds, and here are eight twelfths.');
    expect(p.markers.map(m => m.id)).toEqual(['b1', 'b2']);
    expect(at(p.speech, p.markers[0]!.pos)).toBe(', and here are eight twelfths.');
    expect(at(p.speech, p.markers[1]!.pos)).toBe('.');
  });

  it('marker at the start and at the end', () => {
    const start = prepareSentence('⟦b1⟧ Look at this bar.');
    expect(start.display).toBe('Look at this bar.');
    expect(start.markers).toEqual([{ id: 'b1', pos: 0 }]);
    const end = prepareSentence('Look at this bar. ⟦B2⟧');
    expect(end.display).toBe('Look at this bar.');
    expect(end.markers).toEqual([{ id: 'b2', pos: end.speech.length }]);
  });

  it('positions refer to the normalized speech text', () => {
    const p = prepareSentence('So 2/3 ⟦a⟧ equals 8/12 ⟦b⟧ here.');
    expect(p.display).toBe('So 2/3 equals 8/12 here.');
    expect(p.speech).toBe('So two thirds equals eight twelfths here.');
    expect(at(p.speech, p.markers[0]!.pos)).toBe('equals eight twelfths here.');
    expect(at(p.speech, p.markers[1]!.pos)).toBe('here.');
  });

  it('marker glued to a word and inside a word boundary', () => {
    const p = prepareSentence('Look⟦x⟧ at the top number.');
    expect(p.display).toBe('Look at the top number.');
    expect(at(p.speech, p.markers[0]!.pos)).toBe(' at the top number.'.trimStart());
  });

  it('accepts [[id]], keeps repeated ids (each occurrence anchors one item), lower-cases', () => {
    const p = prepareSentence('First [[S1]] then ⟦s1⟧ again [[t-2]].');
    expect(p.display).toBe('First then again.');
    expect(p.markers.map(m => m.id)).toEqual(['s1', 's1', 't-2']);
  });

  it('drops malformed markers without an anchor and never speaks them', () => {
    for (const raw of ['Look ⟦b1 at this.', 'Look ⟦⟧ at this.', 'Look [[ ]] at this.', 'Look ⟧ at this.', 'Look [[b1 at this.', 'Look ⟦b 1⟧ at this.']) {
      const p = prepareSentence(raw);
      expect(p.markers, raw).toEqual([]);
      expect(p.speech, raw).not.toMatch(/[⟦⟧[\]]/);
      expect(p.display, raw).not.toMatch(/[⟦⟧[\]]/);
      expect(p.speech, raw).toMatch(/^Look .*at this\.$/);
    }
  });

  it('a sentence that is only a marker becomes empty', () => {
    expect(prepareSentence('⟦b9⟧')).toEqual({ display: '', speech: '', markers: [{ id: 'b9', pos: 0 }] });
  });

  it('keeps math notation unharmed', () => {
    expect(hasMarkers('\\frac{1}{2} and [1, 2] and f(x)')).toBe(false);
    expect(prepareSentence('A list [1, 2] stays ⟦m⟧ here.').display).toBe('A list [1, 2] stays here.');
  });
});

describe('helpers', () => {
  it('stripMarkers and markerIds', () => {
    expect(stripMarkers('Here ⟦b1⟧, and [[b2]] there.')).toBe('Here, and there.');
    expect(markerIds('Here ⟦b1⟧, and [[B2]] there ⟦b1⟧.')).toEqual(['b1', 'b2']);
  });
  it('normalizeForSpeech never speaks markers (safety net)', () => {
    expect(normalizeForSpeech('Look ⟦b1⟧ here [[b2]].')).toBe('Look here.');
  });
  // A trailing marker after the last sentence end comes out as its own piece; the worker
  // attaches it to the end of the previous sentence (prepareSentence gives display '').
  it('chunker keeps markers inside their sentence', () => {
    const c = new SentenceChunker();
    const text = 'Here are two thirds ⟦b1⟧, and here are eight twelfths ⟦b2⟧. Which one covers more of the bar? ⟦b3⟧';
    const out: string[] = [];
    for (const ch of text.match(/.{1,3}/gs)!) out.push(...c.push(ch));
    out.push(...c.flush());
    expect(out).toEqual(['Here are two thirds ⟦b1⟧, and here are eight twelfths ⟦b2⟧.', 'Which one covers more of the bar?', '⟦b3⟧']);
  });
});
