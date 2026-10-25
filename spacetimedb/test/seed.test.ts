import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SIM_STUDENTS } from '../../shared/src/classroom/simStudents';
import { simSeed } from '../src/classroom';
import { SEED_SESSION_BASE, isSeedSessionOf, seedSessionId, seedSessionIndex, validateSeed } from '../src/seed';
import { call, makeLearner, makeSession, mod, proc, setup, type H } from './helpers';

const SEED = {
  daysAgo: 2,
  notes: [
    { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Multiplied only the bottom number: 2/3 = 2/12.', outcome: 'unknown', quote: 'just times the bottom by 4' },
    { kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Cutting each pizza slice into 4 made it click.', outcome: 'worked' },
    { kind: 'preference', category: 'fractions', text: 'Wants the picture before the numbers.', outcome: 'worked' },
    { kind: 'understood', category: 'decimals', concept: 'decimals-tenths', text: 'Knows 0.5 is one half.', outcome: 'worked' },
  ],
  mastery: [{ concept: 'fractions-expand', mastery: 35 }, { concept: 'fractions-unit', mastery: 80 }],
  summary: { summary: 'Worked on expanding 2/3 with pizza pictures.', nextFocus: 'Multiply top and bottom by the same number.' },
};

const notesOf = (h: H, learnerId: bigint) => [...h.db.memoryNote.learnerId.filter(learnerId)];
const seedIt = (env: ReturnType<typeof setup>, learnerId: bigint, seed: unknown = SEED, who = env.agent) =>
  call(env.h, who, mod.seedMemory, { learnerId, memory: JSON.stringify(seed) });

describe('seedMemory', () => {
  it('is agent only', () => {
    const env = setup();
    const l = makeLearner(env.h, env.client, 'Ava Chen');
    expect(() => seedIt(env, l.id, SEED, env.client)).toThrow(/agent only/);
    expect(notesOf(env.h, l.id)).toHaveLength(0);
  });

  it('writes notes + evidence, mastery and a past summary', () => {
    const env = setup();
    const { h } = env;
    const l = makeLearner(h, env.client, 'Ava Chen');
    seedIt(env, l.id);
    const notes = notesOf(h, l.id);
    expect(notes.map(n => n.text).sort()).toEqual(SEED.notes.map(n => n.text).sort());
    const mis = notes.find(n => n.kind === 'misconception')!;
    expect(mis).toMatchObject({ category: 'fractions', concept: 'fractions-expand', outcome: 'unknown', confidence: 0.9, reinforced: 0 });
    const ev = [...h.db.noteEvidence.noteId.filter(mis.id)];
    expect(ev).toEqual([expect.objectContaining({ sessionId: SEED_SESSION_BASE + l.id, quote: 'just times the bottom by 4' })]);
    const cs = [...h.db.conceptState.learnerId.filter(l.id)];
    expect(cs.map(c => [c.category, c.concept, c.mastery]).sort()).toEqual([['fractions', 'fractions-expand', 35], ['fractions', 'fractions-unit', 80]]);
    const sum = [...h.db.sessionSummary.learnerId.filter(l.id)];
    expect(sum).toHaveLength(1);
    expect(sum[0]!.nextFocus).toBe('Multiply top and bottom by the same number.');
    expect(sum[0]!.createdAt.microsSinceUnixEpoch < h.clock.now().microsSinceUnixEpoch).toBe(true); // dated in the past
  });

  it('is idempotent: re-seeding replaces seeded notes but keeps live notes', () => {
    const env = setup();
    const { h } = env;
    const l = makeLearner(h, env.client, 'Ava Chen');
    seedIt(env, l.id);
    const s = makeSession(h, env.client, l.id);
    call(h, env.agent, mod.remember, { sessionId: s.id, kind: 'quote', category: 'fractions', concept: '', text: 'said "pizza math is fun"', outcome: 'worked' });
    seedIt(env, l.id);
    seedIt(env, l.id, { ...SEED, notes: SEED.notes.slice(0, 2), mastery: [{ concept: 'fractions-expand', mastery: 50 }] });
    const notes = notesOf(h, l.id);
    expect(notes).toHaveLength(3);
    expect(notes.map(n => n.text)).toContain('said "pizza math is fun"');
    expect([...h.db.noteEvidence.iter()]).toHaveLength(3); // 2 seeded + 1 live; old seed evidence gone
    expect([...h.db.conceptState.byLearnerConcept.filter([l.id, 'fractions-expand'])].map(c => c.mastery)).toEqual([50]);
    expect([...h.db.sessionSummary.learnerId.filter(l.id)]).toHaveLength(1);
    seedIt(env, l.id, {}); // an empty seed clears seeded notes and the seed summary
    expect(notesOf(h, l.id).map(n => n.text)).toEqual(['said "pizza math is fun"']);
    expect([...h.db.sessionSummary.learnerId.filter(l.id)]).toHaveLength(0);
  });

  it('validates against the taxonomy, kinds and outcomes (nothing written on error)', () => {
    const env = setup();
    const l = makeLearner(env.h, env.client, 'Ava Chen');
    const bad = (note: Record<string, unknown>) => ({ notes: [{ kind: 'strategy', category: 'fractions', text: 'x', ...note }] });
    expect(() => seedIt(env, l.id, bad({ kind: 'favorite' }))).toThrow(/kind must be one of/);
    expect(() => seedIt(env, l.id, bad({ category: 'cooking' }))).toThrow(/unknown category/);
    expect(() => seedIt(env, l.id, bad({ concept: 'decimals-tenths' }))).toThrow(/does not belong/);
    expect(() => seedIt(env, l.id, bad({ outcome: 'maybe' }))).toThrow(/outcome must be one of/);
    expect(() => seedIt(env, l.id, bad({ text: '' }))).toThrow(/text must be/);
    expect(() => seedIt(env, l.id, { mastery: [{ concept: 'nope', mastery: 10 }] })).toThrow(/unknown concept/);
    expect(() => seedIt(env, l.id, { mastery: [{ concept: 'place-value', mastery: 101 }] })).toThrow(/0-100/);
    expect(() => seedIt(env, l.id, { summary: { summary: '' } })).toThrow(/summary.summary/);
    expect(() => call(env.h, env.agent, mod.seedMemory, { learnerId: l.id, memory: 'not json' })).toThrow(/JSON object/);
    expect(() => seedIt(env, 999n)).toThrow(/not found/);
    expect(notesOf(env.h, l.id)).toHaveLength(0);
  });

  it('rejects simulated learners', () => {
    const env = setup();
    call(env.h, env.client, mod.resetSimulatedStudents, { count: 1 });
    const sim = [...env.h.db.learner.iter()].find(l => l.isSimulated)!;
    expect(() => seedIt(env, sim.id)).toThrow(/simulated/);
  });

  it('buildContext of a later session shows the seeded notes, mastery and last session', () => {
    const env = setup();
    const { h } = env;
    const l = makeLearner(h, env.client, 'Ava Chen');
    seedIt(env, l.id);
    const s = makeSession(h, env.client, l.id, 'Expand 2/3 so the bottom number is 12.');
    let text: string = (mod.buildContext as any)(proc(h, env.agent), { sessionId: s.id });
    // Before the topic is set: only preferences (+ the last session).
    expect(text).toContain('Wants the picture before the numbers.');
    expect(text).not.toContain('Multiplied only the bottom number');
    expect(text).toContain('last session: Worked on expanding 2/3 with pizza pictures. Next focus: Multiply top and bottom by the same number.');
    JSON.parse((mod.setTopic as any)(proc(h, env.agent), { sessionId: s.id, category: 'fractions', concept: 'fractions-expand' }));
    text = (mod.buildContext as any)(proc(h, env.agent), { sessionId: s.id });
    expect(text).toContain('- misconception [fractions-expand]: Multiplied only the bottom number: 2/3 = 2/12.');
    expect(text).toContain('- strategy [fractions-expand]: Cutting each pizza slice into 4 made it click. (worked)');
    expect(text).toContain('- mastery fractions-expand: 35/100');
    expect(text).not.toContain('Knows 0.5 is one half.'); // other category
    expect(text.indexOf('Multiplied only')).toBeLessThan(text.indexOf('Cutting each pizza')); // file order kept
  });
});

const HISTORY = {
  daysAgo: 2,
  notes: [
    { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Multiplied only the bottom.', quote: 'just the bottom' },
    { kind: 'understood', category: 'fractions', concept: 'fractions-unit', text: 'Knows what the bottom number means.', session: 1, quote: 'how many pieces' },
  ],
  mastery: [{ concept: 'fractions-expand', mastery: 35 }, { concept: 'fractions-unit', mastery: 80 }, { concept: 'place-value', mastery: 70 }],
  history: [
    { daysAgo: 2, concept: 'fractions-expand', task: 'Expand 2/3 to sixths.', summary: 'Expanded 2/3 with a pizza.', nextFocus: 'Twelfths.' },
    { daysAgo: 6, concept: 'fractions-unit', task: 'What is one slice of 8?', summary: 'Named 1/8 and 3/8.', nextFocus: 'Expanding.' },
  ],
};

describe('seed history (several earlier sessions)', () => {
  it('pseudo session ids: index 0 is the old scheme, unique per learner and index, all >= SEED_SESSION_BASE', () => {
    expect(seedSessionId(7n)).toBe(SEED_SESSION_BASE + 7n);
    const ids = [1n, 2n, 1n << 39n].flatMap(l => [0, 1, 2, 4].map(i => ({ l, i, id: seedSessionId(l, i) })));
    expect(new Set(ids.map(x => x.id)).size).toBe(ids.length);
    for (const { l, i, id } of ids) {
      expect(id >= SEED_SESSION_BASE && id < 1n << 63n).toBe(true);
      expect(isSeedSessionOf(id, l)).toBe(true);
      expect(isSeedSessionOf(id, l + 1n)).toBe(false);
      expect(seedSessionIndex(id)).toBe(i);
    }
    expect(isSeedSessionOf(5n, 5n)).toBe(false);
  });

  it('writes one seed_session + summary per history entry, notes and mastery dated with their session', () => {
    const env = setup();
    const { h } = env;
    const l = makeLearner(h, env.client, 'Ava Chen');
    seedIt(env, l.id, HISTORY);
    const now = h.clock.now().microsSinceUnixEpoch;
    const day = 86_400_000_000n;
    const seeded = [...h.db.seedSession.learnerId.filter(l.id)].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
    expect(seeded.map(s => [s.sessionId, s.taskText, s.category, s.concept, s.startedAt.microsSinceUnixEpoch])).toEqual([
      [seedSessionId(l.id, 0), 'Expand 2/3 to sixths.', 'fractions', 'fractions-expand', now - 2n * day],
      [seedSessionId(l.id, 1), 'What is one slice of 8?', 'fractions', 'fractions-unit', now - 6n * day],
    ]);
    const sums = [...h.db.sessionSummary.learnerId.filter(l.id)];
    expect(sums.map(s => [s.sessionId, s.summary]).sort()).toEqual([[seedSessionId(l.id, 0), 'Expanded 2/3 with a pizza.'], [seedSessionId(l.id, 1), 'Named 1/8 and 3/8.']].sort());
    const notes = notesOf(h, l.id);
    const ev = (text: string) => [...h.db.noteEvidence.noteId.filter(notes.find(n => n.text === text)!.id)][0]!;
    expect(ev('Multiplied only the bottom.')).toMatchObject({ sessionId: seedSessionId(l.id, 0), quote: 'just the bottom' });
    expect(ev('Knows what the bottom number means.')).toMatchObject({ sessionId: seedSessionId(l.id, 1), quote: 'how many pieces' });
    expect(notes.find(n => n.kind === 'understood')!.createdAt.microsSinceUnixEpoch).toBe(now - 6n * day - 1n);
    const cs = Object.fromEntries([...h.db.conceptState.learnerId.filter(l.id)].map(c => [c.concept, c.updatedAt.microsSinceUnixEpoch]));
    expect(cs).toEqual({ 'fractions-expand': now - 2n * day, 'fractions-unit': now - 6n * day, 'place-value': now - 2n * day });
    // re-seeding with one session removes the other seed_session and summary
    seedIt(env, l.id, { ...HISTORY, notes: [], history: HISTORY.history.slice(0, 1) });
    expect([...h.db.seedSession.learnerId.filter(l.id)]).toHaveLength(1);
    expect([...h.db.sessionSummary.learnerId.filter(l.id)]).toHaveLength(1);
    seedIt(env, l.id, {});
    expect([...h.db.seedSession.learnerId.filter(l.id)]).toHaveLength(0);
  });

  it('validates history: distinct dates, known topic, note session in range', () => {
    const env = setup();
    const l = makeLearner(env.h, env.client, 'Ava Chen');
    const s = (o: object) => ({ summary: 'x', ...o });
    expect(() => seedIt(env, l.id, { history: [s({ daysAgo: 3 }), s({ daysAgo: 3 })] })).toThrow(/different daysAgo/);
    expect(() => seedIt(env, l.id, { summary: { summary: 'x' }, history: [s({})] })).toThrow(/different daysAgo/); // both default to daysAgo 2
    expect(() => seedIt(env, l.id, { history: [s({ concept: 'cooking' })] })).toThrow(/history\[0\]\.concept: unknown concept/);
    expect(() => seedIt(env, l.id, { history: [s({ daysAgo: 400 })] })).toThrow(/history\[0\]\.daysAgo/);
    expect(() => seedIt(env, l.id, { history: [s({ summary: '' })] })).toThrow(/history\[0\]\.summary/);
    expect(() => seedIt(env, l.id, { notes: [{ kind: 'strategy', category: 'fractions', text: 'x', session: 1 }], history: [s({})] })).toThrow(/session 1 does not exist/);
    expect(() => seedIt(env, l.id, { history: [1, 2, 3, 4, 5, 6].map(d => s({ daysAgo: d })) })).toThrow(/at most 5/);
    expect(notesOf(env.h, l.id)).toHaveLength(0);
  });

  it('every simulated persona passes the seed validator (taxonomy, kinds, limits) with 1-2 dated sessions', () => {
    for (const p of SIM_STUDENTS) {
      const { errors, seed } = validateSeed(simSeed(p));
      expect(errors, p.name).toEqual([]);
      expect(seed.sessions.length, p.name).toBeGreaterThanOrEqual(1);
      expect(seed.sessions.length, p.name).toBeLessThanOrEqual(2);
      expect(p.mastery.length, p.name).toBeGreaterThanOrEqual(2);
      expect(p.mastery.length, p.name).toBeLessThanOrEqual(3);
      for (const s of seed.sessions) expect(s.task && s.concept && s.category && s.nextFocus, p.name).toBeTruthy();
      expect(p.memory.some(n => n.quote), p.name).toBe(true);
      // newest first, as documented
      expect(p.history.map(h => h.daysAgo), p.name).toEqual([...p.history.map(h => h.daysAgo)].sort((a, b) => a - b));
    }
  });

  it('scripts/demo-seed.json passes the seed validator with 2 sessions per student', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../../scripts/demo-seed.json'), 'utf8'));
    for (const s of file.students) {
      const { errors, seed } = validateSeed(s.memory);
      expect(errors, s.name).toEqual([]);
      expect(seed.sessions, s.name).toHaveLength(2);
      for (const x of seed.sessions) expect(x.task && x.concept, s.name).toBeTruthy();
    }
  });

  it('the seedMemory reducer still refuses simulated learners', () => {
    const env = setup();
    call(env.h, env.client, mod.resetSimulatedStudents, { count: 1 });
    const sim = [...env.h.db.learner.iter()].find(l => l.isSimulated)!;
    const before = [...env.h.db.seedSession.learnerId.filter(sim.id)].length;
    expect(before).toBe(SIM_STUDENTS[0]!.history.length);
    expect(() => seedIt(env, sim.id, HISTORY)).toThrow(/simulated/);
    expect([...env.h.db.seedSession.learnerId.filter(sim.id)]).toHaveLength(before);
  });
});
