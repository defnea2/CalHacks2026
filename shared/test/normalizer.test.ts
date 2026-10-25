import { describe, expect, it } from 'vitest';
import { fractionWords, normalizeForSpeech as n, numberToWords, ordinalWords } from '../src/normalizer';

describe('number words', () => {
  it('cardinals', () => {
    expect(numberToWords('0')).toBe('zero');
    expect(numberToWords('7')).toBe('seven');
    expect(numberToWords('21')).toBe('twenty-one');
    expect(numberToWords('305')).toBe('three hundred five');
    expect(numberToWords('1,000')).toBe('one thousand');
    expect(numberToWords('12045')).toBe('twelve thousand forty-five');
  });
  it('ordinals', () => {
    expect(ordinalWords('1')).toBe('first');
    expect(ordinalWords('3')).toBe('third');
    expect(ordinalWords('8')).toBe('eighth');
    expect(ordinalWords('12')).toBe('twelfth');
    expect(ordinalWords('20')).toBe('twentieth');
    expect(ordinalWords('21')).toBe('twenty-first');
  });
  it('fractions', () => {
    expect(fractionWords('3', '4')).toBe('three quarters');
    expect(fractionWords('1', '4')).toBe('one quarter');
    expect(fractionWords('1', '2')).toBe('one half');
    expect(fractionWords('3', '2')).toBe('three halves');
    expect(fractionWords('2', '3')).toBe('two thirds');
    expect(fractionWords('1', '3')).toBe('one third');
    expect(fractionWords('5', '8')).toBe('five eighths');
    expect(fractionWords('8', '20')).toBe('eight twentieths');
    expect(fractionWords('1', '10')).toBe('one tenth');
  });
});

describe('normalizeForSpeech', () => {
  it('reads fractions', () => {
    expect(n('3/4')).toBe('three quarters');
    expect(n('1/2')).toBe('one half');
    expect(n('2/3')).toBe('two thirds');
    expect(n('So 3/4 is more than 2/3.')).toBe('So three quarters is more than two thirds.');
    expect(n('1/5 + 2/5 = 3/5')).toBe('one fifth plus two fifths equals three fifths');
  });

  it('reads decimals', () => {
    expect(n('3.5')).toBe('three point five');
    expect(n('That is 0.25 of a dollar.')).toBe('That is zero point two five of a dollar.');
    expect(n('It costs 3.5.')).toBe('It costs three point five.');
  });

  it('reads operators, equals and percent', () => {
    expect(n('3 + 4 = 7')).toBe('three plus four equals seven');
    expect(n('12 - 5 = 7')).toBe('twelve minus five equals seven');
    expect(n('4 × 3 = 12')).toBe('four times three equals twelve');
    expect(n('4 x 3')).toBe('four times three');
    expect(n('4 * 3')).toBe('four times three');
    expect(n('12 ÷ 3 = 4')).toBe('twelve divided by three equals four');
    expect(n('50% of the pizza')).toBe('fifty percent of the pizza');
    expect(n('x = -3')).toBe('x equals negative three');
    expect(n('3 < 5 and 5 > 3')).toBe('three is less than five and five is greater than three');
  });

  it('reads parentheses like 2(x + 3)', () => {
    expect(n('2(x + 3)')).toBe('two times the group x plus three');
    expect(n('2(x + 3) = 2x + 6')).toBe('two times the group x plus three, equals two x plus six');
    expect(n('Pizza (the round kind) is great.')).toBe('Pizza, the round kind, is great.');
  });

  it('keeps hyphenated words and expands abbreviations', () => {
    expect(n('two-thirds of the class')).toBe('two-thirds of the class');
    expect(n('Equal fractions, e.g. 1/2 and 2/4.')).toBe('Equal fractions, for example one half and two quarters.');
  });

  it('strips leftover LaTeX', () => {
    expect(n('$\\frac{3}{4}$')).toBe('three quarters');
    expect(n('\\(\\frac{1}{2} = \\frac{\\square}{6}\\)')).toBe('one half equals blank over six');
    expect(n('$3 \\cdot 4 = 12$')).toBe('three times four equals twelve');
    expect(n('$x^2$ and \\sqrt{9}')).toBe('x squared and the square root of nine');
    expect(n('\\text{slices}: 8')).toBe('slices: eight');
  });

  it('strips markdown', () => {
    expect(n('**Great** job, you got *it*!')).toBe('Great job, you got it!');
    expect(n('- First step: `3/4`')).toBe('First step: three quarters');
    expect(n('## Rule')).toBe('Rule');
  });

  it('leaves plain sentences alone', () => {
    const s = "Let's cut every slice into two smaller slices. Does that make sense?";
    expect(n(s)).toBe(s);
  });

  it('reads ordinals and big numbers', () => {
    expect(n('the 3rd slice')).toBe('the third slice');
    expect(n('1,000 sticks')).toBe('one thousand sticks');
  });
});
