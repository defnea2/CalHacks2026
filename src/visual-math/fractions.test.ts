import { expect, it } from 'vitest';
import { compareFractions, partitionWidth } from './fractions';

it('preserves equal whole widths across all supported partitions', () => {
  for (let parts = 1; parts <= 12; parts++) expect(parts * partitionWidth(parts)).toBeCloseTo(100);
  expect(() => partitionWidth(0)).toThrow();
});
it('compares rational amounts exactly, including equivalent fractions', () => {
  expect(compareFractions(1, 3, 1, 6)).toBe(1);
  expect(compareFractions(1, 3, 2, 6)).toBe(0);
  expect(compareFractions(1, 8, 1, 4)).toBe(-1);
  expect(() => compareFractions(1, 0, 1, 2)).toThrow();
});
