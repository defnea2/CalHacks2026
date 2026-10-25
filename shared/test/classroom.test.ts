import { describe, it, expect } from 'vitest';
import { SIM_STUDENTS } from '../src/classroom/simStudents';
import { clusterViolations, repairClusters, sizePartitions, sizeRuleText, type Cluster, type ClusterStudent } from '../src/classroom/clusters';
import { stripLearnerIds } from '../src/classroom/dashboardText';
import { pack } from '../src/lesson/index';
import { conceptBelongsTo, isCategory } from '../src/lesson/api';
import { MEMORY_KINDS, MEMORY_OUTCOMES } from '../src/types';

describe('simulated seed students', () => {
  it('20 students in rank order 1..20 with unique names, ages 8-12, grades 3-6', () => {
    expect(SIM_STUDENTS.map(s => s.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(SIM_STUDENTS.map(s => s.name)).size).toBe(20);
    for (const s of SIM_STUDENTS) {
      expect(s.age).toBeGreaterThanOrEqual(8);
      expect(s.age).toBeLessThanOrEqual(12);
      expect(s.grade).toBeGreaterThanOrEqual(3);
      expect(s.grade).toBeLessThanOrEqual(6);
      expect(s.persona.length).toBeGreaterThan(60);
      expect(s.misconceptions.length).toBeGreaterThanOrEqual(1);
      expect(s.memory.length).toBeGreaterThanOrEqual(3);
      expect(s.memory.length).toBeLessThanOrEqual(6);
    }
  });

  it('seed memory notes use valid kinds, outcomes, categories and concepts', () => {
    for (const s of SIM_STUDENTS) {
      for (const n of s.memory) {
        expect(MEMORY_KINDS).toContain(n.kind);
        expect(MEMORY_OUTCOMES).toContain(n.outcome);
        expect(isCategory(pack, n.category), `${s.name}: ${n.category}`).toBe(true);
        if (n.concept) expect(conceptBelongsTo(pack, n.category, n.concept), `${s.name}: ${n.concept}`).toBe(true);
      }
    }
  });

  it('misconceptions cover fractions, multiplication, place value and decimals', () => {
    const cats = new Set(SIM_STUDENTS.flatMap(s => s.memory.filter(m => m.kind === 'misconception').map(m => m.category)));
    for (const c of ['fractions', 'multiply-divide', 'numbers', 'decimals']) expect(cats.has(c)).toBe(true);
  });
});

// ---------------------------------------------------------------- clusters

const students = (n: number, phases = ['explain', 'practice']): ClusterStudent[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), phase: phases[i % phases.length]!, topic: i % 3 ? 'fractions' : 'decimals' }));
const ids = (s: ClusterStudent[]) => s.map(x => x.id);
const c = (name: string, learnerIds: string[]): Cluster => ({ name, description: `${name} desc`, learnerIds });

/** Small deterministic PRNG for the fuzz test. */
function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe('cluster rules', () => {
  it('valid input is kept unchanged', () => {
    const s = students(6);
    const r = repairClusters([c('A', ['1', '2', '3', '4']), c('B', ['5', '6'])], s);
    expect(r.valid).toBe(true);
    expect(r.clusters.map(x => x.learnerIds)).toEqual([['1', '2', '3', '4'], ['5', '6']]);
  });

  it('size partitions (an odd class groups n - 1)', () => {
    expect(sizePartitions(6)).toEqual([[4, 2], [2, 2, 2]]);
    expect(sizePartitions(7)).toEqual([[4, 2], [2, 2, 2]]);
    expect(sizePartitions(8)).toEqual([[4, 4], [4, 2, 2], [2, 2, 2, 2]]);
    expect(sizePartitions(3)).toEqual([[2]]);
    expect(sizePartitions(1)).toEqual([]);
  });

  it('merged leftovers carry both cluster names', () => {
    const s = students(4);
    const r = repairClusters([c('A', ['1']), c('B', ['2']), c('C', ['3', '4'])], s);
    expect(r.clusters.find(x => x.learnerIds.includes('1'))!.name).toMatch(/A · B|B · A/);
  });

  it('size rule text: never 3, odd class leaves one student out', () => {
    expect(sizeRuleText(6)).toMatch(/exactly 2 or 4/);
    expect(sizeRuleText(7)).toMatch(/leave exactly one student out/);
    expect(sizeRuleText(7)).toMatch(/never 1 or 3/);
    expect(sizeRuleText(3)).toMatch(/leave exactly one student out/);
    expect(sizeRuleText(1)).toMatch(/no clusters/);
  });

  it('violations: sizes, duplicates, unknown, missing; a 3 is never allowed', () => {
    const v = clusterViolations([c('A', ['1', '2', '3']), c('B', ['3', '4', '99'])], ids(students(6)));
    expect(v.join('\n')).toMatch(/unknown student 99/);
    expect(v.join('\n')).toMatch(/student 3 is in 2 clusters/);
    expect(v.join('\n')).toMatch(/student 5 is in no cluster/);
    expect(v.join('\n')).toMatch(/cluster 0 has 3 students/);
    expect(clusterViolations([c('A', ['1', '2', '3'])], ids(students(3))).join()).toMatch(/has 3 students/);
    // odd class: exactly one student stays out
    expect(clusterViolations([c('A', ['1', '2', '3', '4'])], ids(students(5)))).toEqual([]);
    expect(clusterViolations([c('A', ['1', '2'])], ids(students(5))).join()).toMatch(/student 3 is in no cluster/);
    expect(clusterViolations([], ids(students(1)))).toEqual([]);
  });

  it('one big cluster is cut into 4s and 2s; an odd class leaves exactly one ungrouped', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const s = students(n);
      const r = repairClusters([c('All', ids(s))], s);
      expect(clusterViolations(r.clusters, ids(s)), `n=${n}`).toEqual([]);
      expect(r.clusters.every(x => x.learnerIds.length === 2 || x.learnerIds.length === 4), `n=${n}`).toBe(true);
      expect(r.ungrouped, `n=${n}`).toHaveLength(n % 2);
      expect(new Set([...r.clusters.flatMap(x => x.learnerIds), ...r.ungrouped]).size).toBe(n);
    }
  });

  it('singletons are paired by similarity (same phase first)', () => {
    const s: ClusterStudent[] = [
      { id: '1', phase: 'explain', topic: 'f' },
      { id: '2', phase: 'practice', topic: 'f' },
      { id: '3', phase: 'explain', topic: 'f' },
      { id: '4', phase: 'practice', topic: 'f' },
    ];
    const r = repairClusters(['1', '2', '3', '4'].map(i => c(`S${i}`, [i])), s);
    expect(r.clusters.map(x => x.learnerIds.sort())).toEqual([['1', '3'], ['2', '4']]);
  });

  it('odd class: a valid 4 with one student missing is kept as is (the missing one is ungrouped)', () => {
    const s = students(5);
    const r = repairClusters([c('A', ['1', '2', '3', '4'])], s);
    expect(r.valid).toBe(true);
    expect(r.ungrouped).toEqual(['5']);
  });

  it('odd class: an LLM cluster of 3 gives one student up instead of staying a 3', () => {
    const s = students(7);
    const r = repairClusters([c('A', ['1', '2', '3']), c('B', ['4', '5', '6', '7'])], s);
    expect(r.valid).toBe(false);
    expect(r.clusters.map(x => x.learnerIds.length)).toEqual([2, 4]);
    expect(r.ungrouped).toEqual(['3']);
  });

  it('single student: no cluster, ungrouped; empty LLM output is filled', () => {
    expect(repairClusters([], students(1))).toMatchObject({ clusters: [], ungrouped: ['1'] });
    for (const n of [2, 3, 6, 7]) {
      const s = students(n);
      const r = repairClusters([], s);
      expect(clusterViolations(r.clusters, ids(s)), `n=${n}`).toEqual([]);
      expect(r.ungrouped).toHaveLength(n % 2);
    }
  });

  it('fuzz: any LLM output is repaired into a valid partition, deterministically', () => {
    const rand = rng(42);
    for (let iter = 0; iter < 2000; iter++) {
      const n = 1 + Math.floor(rand() * 20);
      const s = students(n, ['a', 'b', 'c']);
      const k = Math.floor(rand() * 7);
      const raw: Cluster[] = Array.from({ length: k }, (_, j) =>
        c(`C${j}`, Array.from({ length: Math.floor(rand() * 7) }, () => (rand() < 0.1 ? '999' : String(1 + Math.floor(rand() * n)))))
      );
      const r = repairClusters(raw, s);
      expect(clusterViolations(r.clusters, ids(s)), JSON.stringify({ n, raw })).toEqual([]);
      expect(r.clusters.some(x => x.learnerIds.length === 3 || x.learnerIds.length === 1)).toBe(false);
      expect(r.ungrouped).toHaveLength(n % 2);
      expect(repairClusters(raw, s)).toEqual(r);
    }
  });
});

describe('stripLearnerIds (dashboard prose)', () => {
  const ls = [
    { id: '16', name: 'Jonas Weber' },
    { id: '7', name: 'Mia Chen' },
  ];
  it('removes id tags after names in their common shapes', () => {
    expect(stripLearnerIds('Jonas (16) and Mia (7) add the bottoms.', ls)).toBe('Jonas and Mia add the bottoms.');
    expect(stripLearnerIds('Jonas Weber (id 16), Mia [#7], Jonas #16, Mia (learner id: 7).', ls)).toBe('Jonas Weber, Mia, Jonas, Mia.');
    expect(stripLearnerIds('Student 16 needs help; learner #7 is done.', ls)).toBe('Jonas needs help; Mia is done.');
  });
  it('keeps maths and other parentheses', () => {
    const t = 'Mia (correctly) got 5/8 + 3/8 = 8/8 (= 1); f(3) and step (2) are fine. Student 99 unknown.';
    expect(stripLearnerIds(t, ls)).toBe(t);
    expect(stripLearnerIds('Jonas (3/8) is close.', ls)).toBe('Jonas (3/8) is close.');
  });
});
