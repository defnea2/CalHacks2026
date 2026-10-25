import type { TaxonomyCategory } from '../types';

// Concept tags: at most 10 categories, each with finer concepts. Used by tools, library and memory.
export const taxonomy: TaxonomyCategory[] = [
  { key: 'numbers', title: 'Numbers', concepts: [{ key: 'place-value', title: 'Place value' }] },
  { key: 'add-subtract', title: 'Adding and subtracting', concepts: [{ key: 'regrouping', title: 'Carrying and borrowing' }] },
  {
    key: 'multiply-divide',
    title: 'Multiplying and dividing',
    concepts: [
      { key: 'multiplication-groups', title: 'Multiplication as equal groups' },
      { key: 'division-sharing', title: 'Division as fair sharing' },
    ],
  },
  {
    key: 'fractions',
    title: 'Fractions',
    concepts: [
      { key: 'fractions-unit', title: 'What a fraction is' },
      { key: 'fractions-compare', title: 'Comparing fractions' },
      { key: 'fractions-expand', title: 'Expanding fractions' },
      { key: 'fractions-add-same', title: 'Adding fractions with the same denominator' },
    ],
  },
  { key: 'decimals', title: 'Decimals', concepts: [{ key: 'decimals-tenths', title: 'Tenths and hundredths' }] },
  { key: 'measurement', title: 'Measurement', concepts: [{ key: 'units-length', title: 'Units of length' }] },
  { key: 'geometry', title: 'Geometry', concepts: [{ key: 'area-perimeter', title: 'Area and perimeter' }] },
  { key: 'data', title: 'Data', concepts: [{ key: 'bar-charts', title: 'Reading bar charts' }] },
];
