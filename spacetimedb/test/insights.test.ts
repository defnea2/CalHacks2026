import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

  it('seedMemory notes are seeded, pseudo session ids are hidden, seed summary is returned', () => {
    const env = setup();
    const { h } = env;
    const t = teacher(env);
    const l = makeLearner(h, env.client, 'Ava Chen');
    const seed = {
      daysAgo: 2,
      notes: [
        { kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Cutting each pizza slice into 4 made it click.', outcome: 'worked', quote: 'oh, four times more slices' },
        { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Multiplied only the bottom number.', outcome: 'unknown' },
      ],
      mastery: [{ concept: 'fractions-expand', mastery: 35 }],
      summary: { summary: 'Worked on expanding 2/3 with pizza pictures.', nextFocus: 'Same number top and bottom.' },
    };
    call(h, env.agent, mod.seedMemory, { learnerId: l.id, memory: JSON.stringify(seed) });
    // A real session later reinforces the strategy note: it is no longer seeded.
    const s = makeSession(h, env.client, l.id);
    call(h, env.agent, mod.remember, { sessionId: s.id, kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Cutting each pizza slice into 4 made it click.', outcome: 'worked' });

    const json = raw(env, l.id, t.id);
    const r = ok(JSON.parse(json));
    expect(r.notes.map(n => [n.kind, n.seeded])).toEqual([['misconception', true], ['strategy', false]]);
    expect(r.notes[0]!.evidence).toEqual([{ sessionId: 'seed-1', fromTurn: 0, toTurn: 0, quote: '' }]);
    expect(r.notes[1]!.evidence.map(e => e.sessionId)).toEqual([String(s.id), 'seed-1']);
    expect(r.notes[1]!.evidence[1]!.quote).toBe('oh, four times more slices');
    expect(r.summaries).toEqual([
      { sessionId: 'seed-1', summary: seed.summary.summary, nextFocus: seed.summary.nextFocus, createdMs: expect.any(Number), taskText: '', topic: '', topicTitle: '' },
    ]);
    expect(r.mastery.map(m => [m.concept, m.mastery])).toEqual([['fractions-expand', 35]]);
    expect(json).not.toContain(String((1n << 62n) + l.id));
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
    for (const n of r.notes) expect(n).toMatchObject({ seeded: true, evidence: [expect.objectContaining({ sessionId: expect.stringMatching(/^seed-\d$/) })] });
  });
});

describe('learnerInsights of simulated students (seeded past via writeSeed)', () => {
  const DAY = 86_400_000;
  const titleOf = (env: Env, key: string) => env.h.db.concept.key.find(key)?.title ?? pack.taxonomy.flatMap(c => c.concepts).find(k => k.key === key)!.title;
  function check(env: Env, t: { id: bigint }, rank: number) {
    const p = SIM_STUDENTS[rank - 1]!;
    const l = [...env.h.db.learner.iter()].find(x => x.isSimulated && x.simRank === rank)!;
    const now = Number(env.h.clock.now().microsSinceUnixEpoch / 1000n);
    const r = ok(read(env, l.id, t.id));
    // past sessions: one per history entry, newest first, with summary, next focus, task and topic
    expect(r.summaries.map(s => s.summary)).toEqual([...p.history].sort((a, b) => a.daysAgo - b.daysAgo).map(h => h.summary));
    for (let i = 1; i < r.summaries.length; i++) expect(r.summaries[i - 1]!.createdMs).toBeGreaterThan(r.summaries[i]!.createdMs);
    for (const s of r.summaries) {
      const h = p.history.find(x => x.summary === s.summary)!;
      expect(s).toMatchObject({ nextFocus: h.nextFocus, taskText: h.task, topic: h.concept, sessionId: expect.stringMatching(/^seed-\d$/) });
      expect(s.topicTitle).toBe(titleOf(env, h.concept));
      expect(s.createdMs).toBe(now - h.daysAgo * DAY);
    }
    expect(new Set(r.summaries.map(s => s.sessionId)).size).toBe(r.summaries.length);
    // header: seeded sessions count, first/last seen are their dates
    expect(r.learner.sessionCount).toBe(p.history.length);
    expect(r.learner.firstSeenMs).toBe(now - Math.max(...p.history.map(h => h.daysAgo)) * DAY);
    expect(r.learner.lastSeenMs).toBe(now - Math.min(...p.history.map(h => h.daysAgo)) * DAY);
    // notes: seeded, evidence on one of the seeded sessions, quotes kept
    expect(r.notes.map(n => n.text).sort()).toEqual(p.memory.map(m => m.text).sort());
    const ids = new Set(r.summaries.map(s => s.sessionId));
    for (const n of r.notes) {
      const m = p.memory.find(x => x.text === n.text)!;
      expect(n.seeded).toBe(true);
      expect(n.evidence).toHaveLength(1);
      expect(ids.has(n.evidence[0]!.sessionId)).toBe(true);
      expect(n.evidence[0]!.quote).toBe(m.quote ?? '');
      const sess = r.summaries.find(s => s.sessionId === n.evidence[0]!.sessionId)!;
      expect(Math.abs(sess.createdMs - n.createdMs)).toBeLessThanOrEqual(1); // dated with its session (staggered by µs)
      if (n.concept) expect(n.conceptTitle).not.toBe('');
    }
    expect(r.notes.filter(n => n.evidence[0]!.quote).length).toBeGreaterThan(0);
    // mastery with titles, dated with a seeded session
    expect(r.mastery.map(m => [m.concept, m.mastery]).sort()).toEqual(p.mastery.map(m => [m.concept, m.mastery]).sort());
    for (const m of r.mastery) {
      expect(m.title).toBe(titleOf(env, m.concept));
      expect(m.categoryTitle).not.toBe('');
      expect(r.summaries.map(s => s.createdMs)).toContain(m.updatedMs);
    }
    expect(JSON.stringify(r)).not.toContain(String(1n << 62n).slice(0, 12)); // raw pseudo ids stay hidden
    return r;
  }

  it('resetSimulatedStudents(0): every persona has notes with evidence, mastery and its history newest first', () => {
    const env = setup();
    const t = teacher(env);
    call(env.h, env.client, mod.resetSimulatedStudents, { count: 0 });
    for (const p of SIM_STUDENTS) check(env, t, p.rank);
    const leo = check(env, t, 4);
    expect(leo.learner.name).toBe('Leo Schneider');
    expect(leo.summaries).toHaveLength(2);
  });

  it('demo seed (scripts/demo-seed.json, seedMemory): every profile field is filled', () => {
    const env = setup();
    const t = teacher(env);
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../../scripts/demo-seed.json'), 'utf8'));
    for (const st of file.students) {
      const l = makeLearner(env.h, env.client, st.name);
      call(env.h, env.agent, mod.seedMemory, { learnerId: l.id, memory: JSON.stringify(st.memory) });
      const r = ok(read(env, l.id, t.id));
      expect(r.learner.sessionCount).toBe(2);
      expect(r.learner.firstSeenMs).toBeLessThan(r.learner.lastSeenMs);
      expect(r.summaries.map(s => s.sessionId)).toEqual(['seed-1', 'seed-2']);
      for (const s of r.summaries) expect(s.summary && s.nextFocus && s.taskText && s.topic && s.topicTitle, st.name).toBeTruthy();
      expect(r.mastery.every(m => m.title !== m.concept && m.categoryTitle && m.updatedMs < r.generatedMs)).toBe(true);
      const quoted = r.notes.filter(n => n.evidence[0]?.quote);
      expect(quoted.length).toBeGreaterThan(1);
      expect(new Set(quoted.map(n => n.evidence[0]!.sessionId))).toEqual(new Set(['seed-1', 'seed-2']));
    }
  });

  it('class start with reset gives the same seeded history; a real session adds to it', () => {
    const env = setup();
    const t = teacher(env);
    call(env.h, env.client, mod.startClassSessionWith, {
      teacherId: t.id, goals: 'g', content: 'Adding fractions', delivery: '', documentName: '', documentMime: '', documentText: '',
      documentData: new Uint8Array(), simulatedCount: 2, resetSimulated: true,
    });
    for (const rank of [1, 2]) {
      const l = [...env.h.db.learner.iter()].find(x => x.isSimulated && x.simRank === rank)!;
      const r = ok(read(env, l.id, t.id));
      const p = SIM_STUDENTS[rank - 1]!;
      const live = [...env.h.db.session.learnerId.filter(l.id)].length;
      expect(r.learner.sessionCount).toBe(p.history.length + live);
      expect(r.summaries.map(s => s.taskText)).toEqual([...p.history].sort((a, b) => a.daysAgo - b.daysAgo).map(h => h.task));
      expect(r.notes.every(n => n.seeded && n.evidence.length === 1)).toBe(true);
      expect(r.mastery.length).toBe(p.mastery.length);
    }
  });
});
