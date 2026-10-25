// Topic prefetch cues + the planner's library index / concept material.
import { describe, expect, it } from 'vitest';
import { conceptMaterial, guessTopic, libraryIndex, pack } from '../src/lesson/index';

describe('guessTopic', () => {
  it.each([
    ['Expand 2/3 so the bottom number is 12.', 'fractions-expand'],
    ['Equivalent fractions', 'fractions-expand'],
    ['Why is 2/4 the same as 1/2?', 'fractions-expand'],
    ['Which is bigger, 3/4 or 2/3?', 'fractions-compare'],
    ['What is 0.3 + 0.45?', 'decimals-tenths'],
    ['6 times 7 as groups of apples', 'multiplication-groups'],
    ['Share 12 sweets equally between 3 friends', 'division-sharing'],
  ])('%s -> %s', (text, concept) => {
    expect(guessTopic(pack, text)?.concept).toBe(concept);
  });
  it('no fraction in sight: "smaller" is not about fractions; unknown text gives null', () => {
    expect(guessTopic(pack, 'Page 34, number 5')).toBeNull();
    expect(guessTopic(pack, '')).toBeNull();
    expect(guessTopic(pack, 'the pieces are smaller')?.category).not.toBe('fractions');
  });
  it('only "fractions": the category without a concept', () => {
    expect(guessTopic(pack, 'my fractions homework')).toMatchObject({ category: 'fractions', concept: '' });
  });
});

describe('library index + material', () => {
  it('the index lists every taxonomy concept compactly (about 1-2k tokens) and is stable', () => {
    const idx = libraryIndex(pack);
    for (const c of pack.taxonomy.flatMap(c => c.concepts)) expect(idx).toContain(c.key);
    expect(idx.length).toBeLessThan(8000);
    expect(libraryIndex(pack)).toBe(idx);
  });
  it('the material of a concept: skills with steps and common mistake, explanations, tasks with answers', () => {
    const m = conceptMaterial(pack, 'fractions-expand')!;
    expect(m.title).toBe('Expanding fractions');
    expect((m.skills as { commonMistake: string }[])[0]!.commonMistake).toMatch(/only the top/);
    expect((m.tasks as { answer: string }[]).some(t => t.answer === '8/12')).toBe(true);
    expect(JSON.stringify(m).length).toBeLessThan(9000);
    expect(conceptMaterial(pack, 'regrouping')).toBeNull();
  });
});
