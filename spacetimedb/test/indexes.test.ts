// Index lookups that replaced full-table scans (docs/ARCHITECTURE.md §2): the index exists, and
// the code path that uses it returns exactly the rows of the scan it replaced.
import { describe, it, expect } from 'vitest';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { linkedSessions, simUser } from '../src/classroom';
import { metricsForUtterance, utteranceSentences } from '../src/ctx';
import { call, makeLearner, makeSession, mod, setup, studentSays, type H } from './helpers';

function startClass(env: ReturnType<typeof setup>, teacherId: bigint, simulatedCount = 0) {
  call(env.h, env.client, mod.startClassSession, {
    teacherId,
    goals: 'Add fractions',
    content: '1/4 + 2/4',
    delivery: '',
    documentName: '',
    documentMime: '',
    documentText: '',
    documentData: new Uint8Array(),
    simulatedCount,
  });
  return [...env.h.db.classSession.iter()].filter(c => c.teacherId === teacherId && c.active)[0]!;
}

const read = <T>(h: H, f: (ctx: any) => T): T => {
  let out: T;
  h.withReducerTx(TestAuth.internal(), ctx => {
    out = f(ctx);
  });
  return out!;
};

describe('new btree indexes', () => {
  it('exist on the lookup columns', () => {
    const { h } = setup();
    for (const [table, col] of [
      ['session', 'classSessionId'],
      ['learner', 'simRank'],
      ['learner', 'isSimulated'],
      ['presence', 'status'],
      ['replySentence', 'utteranceId'],
      ['turnMetrics', 'utteranceId'],
      ['extractionJob', 'sessionId'],
      ['summaryJob', 'sessionId'],
      ['ttsJob', 'sessionId'],
      ['ttsJob', 'utteranceId'],
      ['sttJob', 'sessionId'],
      ['textPlayJob', 'sessionId'],
    ] as const) {
      expect(typeof (h.db as any)[table][col]?.filter, `${table}.${col}`).toBe('function');
    }
  });

  it('linkedSessions: only active sessions of that class, via session.classSessionId', () => {
    const env = setup();
    const { h, client } = env;
    call(h, client, mod.createTeacher, { name: 'Ms. Park' });
    call(h, client, mod.createTeacher, { name: 'Mr. Alvarez' });
    const [t1, t2] = [...h.db.teacher.iter()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const a = makeLearner(h, client, 'Ava');
    const b = makeLearner(h, client, 'Ben');
    call(h, client, mod.setPresence, { learnerId: a.id, status: 'waiting' });
    const c1 = startClass(env, t1!.id, 2);
    call(h, client, mod.setPresence, { learnerId: b.id, status: 'in_session' });
    makeSession(h, client, b.id); // ad-hoc, not linked
    const scan = (id: bigint) => [...h.db.session.iter()].filter(s => s.classSessionId === id && s.active).map(s => s.id).sort();
    const one = read(h, ctx => linkedSessions(ctx, c1.id).map(s => s.id));
    expect(one).toEqual(scan(c1.id));
    expect(one.length).toBe(3); // Ava + 2 simulated students; Ben's ad-hoc session is not linked
    const c2 = startClass(env, t2!.id, 0); // pulls Ava and Ben (both online) into class 2, retires the sims
    expect(read(h, ctx => linkedSessions(ctx, c1.id))).toEqual([]);
    expect(read(h, ctx => linkedSessions(ctx, c2.id).map(s => s.id))).toEqual(scan(c2.id));
    const two = read(h, ctx => linkedSessions(ctx, c2.id).map(s => s.learnerId));
    expect(two.sort()).toEqual([a.id, b.id].sort());
  });

  it('simUser by rank via learner.simRank; real learners (rank 0) never match', () => {
    const env = setup();
    const { h, client } = env;
    makeLearner(h, client, 'Real');
    call(h, client, mod.createTeacher, { name: 'T' });
    startClass(env, [...h.db.teacher.iter()][0]!.id, 3);
    for (const rank of [1, 2, 3]) {
      const l = read(h, ctx => simUser(ctx, rank));
      expect(l?.simRank).toBe(rank);
      expect(l?.isSimulated).toBe(true);
    }
    expect(read(h, ctx => simUser(ctx, 0))).toBeUndefined();
    expect(read(h, ctx => simUser(ctx, 4))).toBeUndefined();
  });

  it('utteranceSentences / metricsForUtterance via the utteranceId indexes, scoped to the session', () => {
    const { h, client, agent } = setup();
    const l1 = makeLearner(h, client, 'A');
    const l2 = makeLearner(h, client, 'B');
    const s1 = makeSession(h, client, l1.id);
    const s2 = makeSession(h, client, l2.id);
    for (const s of [s1, s2]) studentSays(h, client, s.id, 'hi');
    call(h, agent, mod.beginUtterance, { sessionId: s1.id, utteranceId: 7n, replyToIdx: 0, preemptive: false });
    for (const i of [2, 0, 1]) call(h, agent, mod.addSentence, { sessionId: s1.id, utteranceId: 7n, idx: i, display: `S${i}.`, speech: `S${i}.` });
    call(h, agent, mod.beginUtterance, { sessionId: s2.id, utteranceId: 8n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s2.id, utteranceId: 8n, idx: 0, display: 'X.', speech: 'X.' });
    expect(read(h, ctx => utteranceSentences(ctx, s1.id, 7n).map(s => s.idx))).toEqual([0, 1, 2]);
    expect(read(h, ctx => utteranceSentences(ctx, s2.id, 7n))).toEqual([]);
    expect(read(h, ctx => metricsForUtterance(ctx, s1.id, 7n)?.turnIdx)).toBe(0);
    expect(read(h, ctx => metricsForUtterance(ctx, s2.id, 7n))).toBeUndefined();
    expect(read(h, ctx => metricsForUtterance(ctx, s2.id, 8n)?.sessionId)).toBe(s2.id);
  });
});
