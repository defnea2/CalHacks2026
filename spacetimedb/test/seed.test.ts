import { describe, it, expect } from 'vitest';
import { SEED_SESSION_BASE } from '../src/seed';
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
