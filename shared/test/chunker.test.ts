import { describe, expect, it } from 'vitest';
import { SentenceChunker } from '../src/chunker';

/** Streams `text` in small token-like pieces and returns all sentences incl. flush. */
function chunk(text: string, step = 3, opts = {}): string[] {
  const c = new SentenceChunker(opts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)));
  out.push(...c.flush());
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).length;

describe('SentenceChunker', () => {
  it('cuts at . ! ?', () => {
    expect(chunk('Let us look at the pizza together now. How many slices do you see there? That is exactly right, well done!')).toEqual([
      'Let us look at the pizza together now.',
      'How many slices do you see there?',
      'That is exactly right, well done!',
    ]);
  });

  it('gives the same result whatever the token size', () => {
    const text = 'Cut each slice into four smaller pieces. Now we have twelve pieces in total. Is it still the same amount of pizza?';
    const a = chunk(text, 1);
    for (const step of [2, 5, 9, 40, 1000]) expect(chunk(text, step)).toEqual(a);
    expect(a).toHaveLength(3);
  });

  it('never cuts inside decimals like 3.5', () => {
    expect(chunk('The answer is 3.5 and that is a bit more than three. Then we add 0.25 to it, which is a quarter.')).toEqual([
      'The answer is 3.5 and that is a bit more than three.',
      'Then we add 0.25 to it, which is a quarter.',
    ]);
  });

  it('never cuts after abbreviations like e.g. or Mr.', () => {
    expect(chunk('Some fractions are equal, e.g. one half and two quarters are the same. Mr. Smith has twelve cookies to share with friends.')).toEqual([
      'Some fractions are equal, e.g. one half and two quarters are the same.',
      'Mr. Smith has twelve cookies to share with friends.',
    ]);
    expect(chunk('We use i.e. to explain things in a different way. Dr. Lee agrees with you completely.')).toEqual([
      'We use i.e. to explain things in a different way.',
      'Dr. Lee agrees with you completely.',
    ]);
  });

  it('never cuts inside math or parentheses', () => {
    expect(chunk('We can write it as 2(x + 3. Wait, no.) and then simplify it to get the answer. Good job on this step!')).toEqual([
      'We can write it as 2(x + 3. Wait, no.) and then simplify it to get the answer.',
      'Good job on this step!',
    ]);
    expect(chunk('Look at $\\frac{3}{4}. Then$ compare it with the other fraction now. Which one is bigger?')).toEqual([
      'Look at $\\frac{3}{4}. Then$ compare it with the other fraction now.',
      'Which one is bigger?',
    ]);
  });

  it('keeps 3/4 and 2(x + 3) intact', () => {
    const out = chunk('So 3/4 is bigger than 2/3 here. And 2(x + 3) means two groups of x plus three.');
    expect(out).toEqual(['So 3/4 is bigger than 2/3 here.', 'And 2(x + 3) means two groups of x plus three.']);
  });

  it('merges pieces under 6 words with the next sentence', () => {
    expect(chunk('Great job! You found the bottom number all by yourself. Yes. Now what?')).toEqual([
      'Great job! You found the bottom number all by yourself.',
      'Yes. Now what?',
    ]);
  });

  it('a short sentence alone is still flushed at the end', () => {
    expect(chunk('Great job!')).toEqual(['Great job!']);
    expect(chunk('')).toEqual([]);
  });

  it('cuts sentences over 25 words at a comma before a conjunction', () => {
    const s =
      'When you cut every slice of the pizza into four smaller slices you get many more pieces on the plate, but the amount of pizza you can eat stays exactly the same.';
    expect(words(s)).toBeGreaterThan(25);
    expect(chunk(s)).toEqual([
      'When you cut every slice of the pizza into four smaller slices you get many more pieces on the plate,',
      'but the amount of pizza you can eat stays exactly the same.',
    ]);
  });

  it('cuts long sentences at ; or :', () => {
    const s =
      'Here is the rule that always works for every fraction we will ever meet in class today: multiply the top and the bottom by the same number and nothing changes.';
    const out = chunk(s);
    expect(out).toHaveLength(2);
    expect(out[0]!.endsWith('today:')).toBe(true);
    expect(out.every(p => words(p) >= 6)).toBe(true);
  });

  it('does not cut a long sentence at a plain comma or into tiny pieces', () => {
    const s =
      'One, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, and more numbers.';
    // The only candidate is ", and more numbers." -> right piece under 6 words -> no cut.
    expect(chunk(s)).toEqual([s]);
  });

  it('cuts a run-on sentence while it is still streaming', () => {
    const c = new SentenceChunker();
    const first = 'We start with three slices of pizza and we look at them very carefully together with a friend,';
    const out = c.push(first + ' and then we cut each slice into four smaller pieces of the same size');
    expect(out).toEqual([first]);
    expect(c.flush()).toEqual(['and then we cut each slice into four smaller pieces of the same size']);
  });

  it('handles closing quotes and ellipses', () => {
    expect(chunk('You said "the bottom number tells the size." That is a great way to put it. Hmm... let me think about that for a second.')).toEqual([
      'You said "the bottom number tells the size."',
      'That is a great way to put it.',
      'Hmm... let me think about that for a second.',
    ]);
  });

  it('flushComplete emits a finished sentence without waiting for the next token', () => {
    const c = new SentenceChunker();
    expect(c.push('First we cut the pizza into equal slices. ')).toEqual([]);
    expect(c.flushComplete()).toEqual(['First we cut the pizza into equal slices.']);
    expect(c.push('Then we count how many')).toEqual([]);
    expect(c.flushComplete()).toEqual([]); // mid-sentence: keep
    expect(c.push(' slices there are, e.g. ')).toEqual([]);
    expect(c.flushComplete()).toEqual([]); // abbreviation, not an end
    expect(c.flush()).toEqual(['Then we count how many slices there are, e.g.']);
    expect(c.push('Wait for 3.')).toEqual([]);
    expect(c.flushComplete()).toEqual(['Wait for 3.']);
  });

  it('collapses newlines and extra spaces inside a piece', () => {
    expect(chunk('Does that make sense?\n\nLet us see it as a picture.')).toEqual(['Does that make sense? Let us see it as a picture.']);
  });

  it('respects custom limits', () => {
    expect(chunk('Yes. No. Maybe.', 2, { minWords: 1 })).toEqual(['Yes.', 'No.', 'Maybe.']);
  });
});
