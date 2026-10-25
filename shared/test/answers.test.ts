import { describe, expect, it } from 'vitest';
import { checkAnswer, parseFraction, parseNumber, relationSymbol } from '../src/answers';

describe('checkAnswer', () => {
  it('numbers by value, digits or words', () => {
    expect(checkAnswer({ form: 'number', value: '3' }, 'three')).toBe(true);
    expect(checkAnswer({ form: 'number', value: '24' }, 'twenty four')).toBe(true);
    expect(checkAnswer({ form: 'number', value: '0.5' }, '0,5')).toBe(true);
    expect(checkAnswer({ form: 'number', value: '3' }, '4')).toBe(false);
  });
  it('fractions must match in form', () => {
    expect(checkAnswer({ form: 'fraction', value: '3/6' }, '3 / 6')).toBe(true);
    expect(checkAnswer({ form: 'fraction', value: '3/6' }, 'three over six')).toBe(true);
    expect(checkAnswer({ form: 'fraction', value: '3/6' }, '1/2')).toBe(false);
  });
  it('relation choices accept spoken words', () => {
    expect(checkAnswer({ form: 'choice', value: '<' }, 'smaller')).toBe(true);
    expect(checkAnswer({ form: 'choice', value: '>' }, 'Greater than.')).toBe(true);
    expect(checkAnswer({ form: 'choice', value: '=' }, 'the same')).toBe(true);
    expect(checkAnswer({ form: 'choice', value: '<' }, 'bigger')).toBe(false);
    expect(relationSymbol('pizza')).toBeNull();
  });
  it('parsers reject junk', () => {
    expect(parseNumber('banana')).toBeNull();
    expect(parseFraction('3/0')).toBeNull();
  });
});
