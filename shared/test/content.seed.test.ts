// Seed-content tests: the placeholder pack's library has the shape the spec asks for.
// (Unlike pack.contract.test.ts these are specific to the seed content.)
import { describe, expect, it } from 'vitest';
import { pack } from '../src/lesson/index';
import { checkAnswer } from '../src/answers';

const lib = pack.content;

describe('seed content library', () => {
  it('has the 8 seed categories and the 8 seed concepts', () => {
    expect(lib.categories.map(c => c.key)).toEqual(
      expect.arrayContaining(['numbers', 'add-subtract', 'multiply-divide', 'fractions', 'decimals', 'measurement', 'geometry', 'data']),
    );
    expect(lib.concepts.map(c => c.key).sort()).toEqual(
      [
        'place-value',
        'multiplication-groups',
        'division-sharing',
        'fractions-unit',
        'fractions-compare',
        'fractions-expand',
        'fractions-add-same',
        'decimals-tenths',
      ].sort(),
    );
  });

  it('category positions are 1..n', () => {
    expect(lib.categories.map(c => c.position)).toEqual(lib.categories.map((_, i) => i + 1));
  });

  for (const concept of lib.concepts) {
    describe(concept.key, () => {
      const skills = lib.skills.filter(s => s.concept === concept.key);
      it('has 1-3 skills laddered by position 1..n', () => {
        expect(skills.length).toBeGreaterThanOrEqual(1);
        expect(skills.length).toBeLessThanOrEqual(3);
        expect(skills.map(s => s.position).sort()).toEqual(skills.map((_, i) => i + 1));
      });
      it('has an intuition, a rule and a misconception explanation', () => {
        const kinds = lib.explanations.filter(e => e.concept === concept.key).map(e => e.kind);
        expect(kinds).toEqual(expect.arrayContaining(['intuition', 'rule', 'misconception']));
      });
      it('has per skill a worked example, a repair, a gap and 2 solo tasks', () => {
        for (const s of skills) {
          const types = lib.tasks.filter(t => t.skill === s.key).map(t => t.type);
          expect(types.filter(t => t === 'worked_example')).toHaveLength(1);
          expect(types.filter(t => t === 'repair')).toHaveLength(1);
          expect(types.filter(t => t === 'gap')).toHaveLength(1);
          expect(types.filter(t => t === 'solo')).toHaveLength(2);
        }
      });
      it('skill keys are prefixed with the concept key', () => {
        for (const s of skills) expect(s.key.startsWith(`${concept.key}/`)).toBe(true);
      });
    });
  }
});

describe('fractions-expand follows the spec example', () => {
  const t = (key: string) => lib.tasks.find(x => x.key === key)!;
  const concept = lib.concepts.find(c => c.key === 'fractions-expand')!;

  it('concept', () => {
    expect(concept).toMatchObject({ category: 'fractions', gradeBand: '5-6', dependsOn: ['fractions-unit', 'multiplication-groups'] });
  });

  it('three skills with the spec key steps', () => {
    const skills = lib.skills.filter(s => s.concept === 'fractions-expand');
    expect(skills.map(s => [s.key, s.kind, s.keyStepIndex])).toEqual([
      ['fractions-expand/given-factor', 'compute', 2],
      ['fractions-expand/target-denominator', 'compute', 0],
      ['fractions-expand/why-same', 'explain', 2],
    ]);
  });

  it('intuition with two fraction_bar visuals', () => {
    const e = lib.explanations.find(x => x.id === 'fractions-expand/intuition')!;
    const bars = e.boardItems.filter(b => b.content.visual === 'fraction_bar');
    expect(bars.map(b => [b.content.parts, b.content.shaded])).toEqual([
      [3, 2],
      [12, 8],
    ]);
  });

  it('named tasks and answers', () => {
    expect(t('fractions-expand/given-factor/worked')).toMatchObject({ answer: { form: 'fraction', value: '12/20' } });
    expect(t('fractions-expand/given-factor/worked').steps).toHaveLength(3);
    const repair = t('fractions-expand/given-factor/repair');
    expect(repair.wrongStepIndex).toBe(2);
    expect(repair.steps[2]!.show).toBe('\\frac{2}{3} = \\frac{8}{3}');
    expect(t('fractions-expand/given-factor/gap')).toMatchObject({ show: '\\frac{1}{2} = \\frac{\\square}{6}', answer: { form: 'number', value: '3' } });
    expect(t('fractions-expand/given-factor/solo-1').answer.value).toBe('3/6');
    expect(t('fractions-expand/target-denominator/solo-1').answer.value).toBe('8/20');
  });

  it('answers are graded in form: 3/6 is right, 1/2 is not', () => {
    const solo = t('fractions-expand/given-factor/solo-1');
    expect(checkAnswer(solo.answer, 'three over six')).toBe(true);
    expect(checkAnswer(solo.answer, '1/2')).toBe(false);
  });
});
