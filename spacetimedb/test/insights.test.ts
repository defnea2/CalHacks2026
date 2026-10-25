import { describe, it, expect } from 'vitest';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { pack } from '../../shared/src/lesson/index';
import { SIM_STUDENTS } from '../../shared/src/classroom/simStudents';
import type { LearnerInsights, LearnerInsightsResult } from '../../shared/src/insights';
import { resetSimUser } from '../src/classroom';
import { call, chatResponse, makeLearner, makeSession, mod, proc, runExtraction, runSummary, runTts, session, setup, studentSays, ttsSse, type H } from './helpers';

const cat = pack.taxonomy.find(c => c.concepts.length > 1)!;
const concept = cat.concepts[0]!;
type Env = ReturnType<typeof setup>;

function exchange(h: H, env: Env, sessionId: bigint, utt: bigint, student: string, tutor: string) {
  studentSays(h, env.client, sessionId, student);
  const replyToIdx = session(h, sessionId).turnCount - 1;
  call(h, env.agent, mod.beginUtterance, { sessionId, utteranceId: utt, replyToIdx, preemptive: false });
  call(h, env.agent, mod.addSentence, { sessionId, utteranceId: utt, idx: 0, display: tutor, speech: tutor });
  runTts(h, () => ({ status: 200, body: ttsSse(new Uint8Array(480)) }));
  call(h, env.client, mod.markPlayed, { sessionId, utteranceId: utt, idx: 0 });
  call(h, env.agent, mod.appendTutorTurn, { sessionId, utteranceId: utt, text: tutor, interrupted: false });
}

function teacher(env: Env) {
  call(env.h, env.client, mod.createTeacher, { name: 'Ms. Park' });
  return [...env.h.db.teacher.iter()][0]!;
}

function raw(env: Env, learnerId: bigint, teacherId: bigint, key = ''): string {
  return (mod.learnerInsights as any)(proc(env.h, env.client), { learnerId, teacherId, key });
}
function read(env: Env, learnerId: bigint, teacherId: bigint, key = ''): LearnerInsightsResult {
  return JSON.parse(raw(env, learnerId, teacherId, key));
}
function ok(r: LearnerInsightsResult): LearnerInsights {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}

const item = (over: Record<string, unknown>) => ({
  action: 'create', noteId: 0, kind: 'strategy', category: cat.key, concept: concept.key, text: 'Pizza slices make fractions click',
  outcome: 'worked', confidence: 0.9, evidence: { fromTurn: 0, toTurn: 1, quote: 'oh like pizza' }, ...over,
});

describe('learnerInsights gate', () => {
  it('unknown teacher / unknown learner', () => {
    const env = setup();
    const l = makeLearner(env.h, env.client);
    expect(read(env, l.id, 999n)).toEqual({ ok: false, error: 'unknown_teacher' });
    const t = teacher(env);
    expect(read(env, 999n, t.id)).toEqual({ ok: false, error: 'unknown_learner' });
    const r = ok(read(env, l.id, t.id));
    expect(r.learner).toMatchObject({ id: String(l.id), name: 'Mia', age: 9, grade: 4, isSimulated: false, persona: '', sessionCount: 0 });
    expect(r.notes).toEqual([]);
    expect(r.learner.firstSeenMs).toBe(Number(l.createdAt.microsSinceUnixEpoch / 1000n));
  });

  it('INSIGHTS_KEY: wrong or missing key is locked, right key is ok', () => {
    const env = setup({ INSIGHTS_KEY: 'sesame' });
    const l = makeLearner(env.h, env.client);
    const t = teacher(env);
    expect(read(env, l.id, t.id)).toEqual({ ok: false, error: 'locked' });
    expect(read(env, l.id, t.id, 'nope')).toEqual({ ok: false, error: 'locked' });
    expect(read(env, l.id, 999n, 'nope')).toEqual({ ok: false, error: 'locked' });
    expect(read(env, l.id, t.id, 'sesame').ok).toBe(true);
  });
});

describe('learnerInsights content', () => {
  it('notes ordered by kind with evidence, mastery with titles, summaries, no BigInt', () => {
    const env = setup();
    const { h } = env;
    const t = teacher(env);
    const l = makeLearner(h, env.client);
    const s = makeSession(h, env.client, l.id);
    exchange(h, env, s.id, 1n, 'I add the bottoms', 'Let us use pizza.');
    exchange(h, env, s.id, 2n, 'oh like pizza', 'Yes!');
    runExtraction(h, () =>
      chatResponse({
        items: [
          item({ kind: 'preference', text: 'Likes drawing it out', evidence: { fromTurn: 2, toTurn: 2, quote: 'x'.repeat(400) } }),
          item({}),
          item({ kind: 'misconception', text: 'Adds the denominators too', outcome: 'unknown', evidence: { fromTurn: 0, toTurn: 0, quote: 'I add the bottoms' } }),
        ],
        mastery: [{ concept: concept.key, mastery: 40, confidence: 0.8 }],
      })
    );
    call(h, env.client, mod.endSession, { sessionId: s.id });
    runExtraction(h, () => chatResponse({ items: [], mastery: [] }));
    runSummary(h, () => chatResponse({ summary: 'Worked on pizza fractions.', nextFocus: 'Unlike denominators' }));

    const json = raw(env, l.id, t.id);
    const r = ok(JSON.parse(json));
    expect(r.notes.map(n => n.kind)).toEqual(['misconception', 'strategy', 'preference']);
    const mis = r.notes[0]!;
    expect(mis).toMatchObject({ text: 'Adds the denominators too', outcome: 'unknown', seeded: false, concept: concept.key, conceptTitle: concept.title, category: cat.key, reinforced: 0 });
    expect(typeof mis.id).toBe('string');
    expect(mis.evidence).toEqual([{ sessionId: String(s.id), fromTurn: 0, toTurn: 0, quote: 'I add the bottoms' }]);
    expect(r.notes[2]!.evidence[0]!.quote.length).toBeLessThanOrEqual(200);
    expect(r.mastery).toEqual([{ concept: concept.key, title: concept.title, category: cat.key, categoryTitle: cat.title, mastery: 40, updatedMs: expect.any(Number) }]);
    expect(r.summaries).toEqual([
      { sessionId: String(s.id), summary: 'Worked on pizza fractions.', nextFocus: 'Unlike denominators', createdMs: expect.any(Number), taskText: 'Expand 2/3 to twelfths', topic: session(h, s.id).concept, topicTitle: expect.any(String) },
    ]);
    expect(r.learner.sessionCount).toBe(1);
    expect(r.learner.lastSeenMs).toBeGreaterThanOrEqual(r.learner.firstSeenMs);
    expect(r.generatedMs).toBe(Number(h.clock.now().microsSinceUnixEpoch / 1000n));
    // JSON round trip: every number is a plain number (no BigInt would survive stringify anyway).
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(json).not.toMatch(/\d+n\b/);
  });

  it('caps notes at 60 and keeps the last 2 evidence rows per note', () => {
    const env = setup();
    const { h } = env;
    const t = teacher(env);
    const l = makeLearner(h, env.client);
    const s = makeSession(h, env.client, l.id);
    for (let i = 0; i < 3; i++) call(h, env.agent, mod.remember, { sessionId: s.id, kind: 'mnemonic', category: cat.key, concept: '', text: 'Bottom = slice size', outcome: 'worked' });
    h.withReducerTx(TestAuth.internal(), ctx => {
      for (let i = 0; i < 70; i++) {
        ctx.db.memoryNote.insert({ id: 0n, learnerId: l.id, kind: 'quote', category: '', concept: '', text: `q${i}`, outcome: 'unknown', confidence: 0.7, reinforced: 0, createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
      }
    });
    const r = ok(read(env, l.id, t.id));
    expect(r.notes).toHaveLength(60);
    const m = r.notes[0]!;
    expect(m).toMatchObject({ kind: 'mnemonic', reinforced: 2, seeded: false, conceptTitle: '' });
    expect(m.evidence).toHaveLength(2);
  });

  it('seeded simulation notes: seeded true, persona from sim_profile', () => {
    const env = setup();
    const t = teacher(env);
    const sim = env.h.withReducerTx(TestAuth.internal(), ctx => resetSimUser(ctx as never, 1));
    const seed = SIM_STUDENTS.find(p => p.rank === 1)!;
    const r = ok(read(env, sim.id, t.id));
    expect(r.learner.isSimulated).toBe(true);
    expect(r.learner.persona).toBe(env.h.db.simProfile.rank.find(1)!.persona);
    expect(r.learner.persona).not.toBe('');
    expect(r.notes).toHaveLength(seed.memory.length);
    expect(r.notes.length).toBeGreaterThan(0);
    for (const n of r.notes) expect(n).toMatchObject({ seeded: true, evidence: [] });
  });
});
