// Retention sweep (retention.ts): photo bytes N minutes after the session ended, optional lesson JSON after M days.
import { describe, it, expect } from 'vitest';
import { TimeDuration } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { setEnvOverride } from '../src/env';
import { RETENTION_SWEEP_S } from '../src/retention';
import { ENV, call, makeLearner, makeSession, mod, setup, studentSays, type H } from './helpers';

const JPEG = 'image/jpeg';
const bytes = (n: number) => new Uint8Array(n).fill(7);
const advanceMin = (h: H, m: number) => h.clock.advance(TimeDuration.fromMillis(m * 60_000));
const sweep = (h: H) => h.withReducerTx(TestAuth.internal(), ctx => (mod.runRetention as any)(ctx, { job: [...ctx.db.retentionJob.iter()][0] }));

function withPhotos(env: Record<string, string> = {}) {
  const e = setup(env);
  const learner = makeLearner(e.h, e.client);
  const s = makeSession(e.h, e.client, learner.id);
  call(e.h, e.client, mod.uploadPhoto, { sessionId: s.id, mime: JPEG, data: bytes(20) });
  call(e.h, e.client, mod.attachImage, { sessionId: s.id, mime: JPEG, data: bytes(10) });
  studentSays(e.h, e.client, s.id, 'here is my drawing'); // binds the turn photo
  call(e.h, e.client, mod.attachImage, { sessionId: s.id, mime: JPEG, data: bytes(10) }); // pending one
  return { ...e, s };
}
const photos = (h: H, sessionId: bigint) => ({ turn: [...h.db.turnImage.sessionId.filter(sessionId)].length, task: h.db.sessionImage.sessionId.find(sessionId) ? 1 : 0 });

describe('retention_job', () => {
  it('init creates one interval row; connects keep it at one', () => {
    const { h, client } = setup();
    const jobs = () => [...h.db.retentionJob.iter()];
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]!.scheduledAt.tag).toBe('Interval');
    expect((jobs()[0]!.scheduledAt.value as TimeDuration).micros).toBe(BigInt(RETENTION_SWEEP_S) * 1_000_000n);
    h.withReducerTx(client, ctx => (mod.onConnect as any)(ctx, {}));
    h.withReducerTx(client, ctx => (mod.onConnect as any)(ctx, {}));
    expect(jobs()).toHaveLength(1);
  });

  it('only the scheduler may run it', () => {
    const { h, client } = setup();
    expect(() => h.withReducerTx(client, ctx => (mod.runRetention as any)(ctx, { job: [...ctx.db.retentionJob.iter()][0] }))).toThrow(/scheduler only/);
  });
});

describe('photo retention', () => {
  it('keeps photos of an active session, deletes them RETENTION_IMAGE_MIN (30) minutes after it ended', () => {
    const { h, client, s } = withPhotos();
    expect(photos(h, s.id)).toEqual({ turn: 2, task: 1 });
    advanceMin(h, 120);
    sweep(h);
    expect(photos(h, s.id)).toEqual({ turn: 2, task: 1 }); // still active
    call(h, client, mod.endSession, { sessionId: s.id });
    advanceMin(h, 29);
    sweep(h);
    expect(photos(h, s.id)).toEqual({ turn: 2, task: 1 });
    advanceMin(h, 2);
    sweep(h);
    expect(photos(h, s.id)).toEqual({ turn: 0, task: 0 });
    // History flags stay; the next sweep is a no-op.
    expect([...h.db.turn.sessionId.filter(s.id)].some(t => t.hasPhoto)).toBe(true);
    sweep(h);
    expect(photos(h, s.id)).toEqual({ turn: 0, task: 0 });
  });

  it('RETENTION_IMAGE_MIN sets the delay; off keeps photos', () => {
    const a = withPhotos({ RETENTION_IMAGE_MIN: '5' });
    call(a.h, a.client, mod.endSession, { sessionId: a.s.id });
    advanceMin(a.h, 6);
    sweep(a.h);
    expect(photos(a.h, a.s.id)).toEqual({ turn: 0, task: 0 });

    const b = withPhotos({ RETENTION_IMAGE_MIN: 'off' });
    call(b.h, b.client, mod.endSession, { sessionId: b.s.id });
    advanceMin(b.h, 60 * 24 * 30);
    sweep(b.h);
    expect(photos(b.h, b.s.id)).toEqual({ turn: 2, task: 1 });
    setEnvOverride(ENV);
  });

  it('class document image: deleted 30 minutes after the class session ended', () => {
    const { h, client } = setup();
    call(h, client, mod.createTeacher, { name: 'T' });
    const teacherId = [...h.db.teacher.iter()][0]!.id;
    call(h, client, mod.startClassSession, { teacherId, goals: 'g', content: 'c', delivery: '', documentName: 'sheet', documentMime: JPEG, documentText: '', documentData: bytes(30), simulatedCount: 0 });
    const cls = [...h.db.classSession.iter()][0]!;
    advanceMin(h, 90);
    sweep(h);
    expect(h.db.classDocument.classSessionId.find(cls.id)).toBeTruthy();
    call(h, client, mod.endClassSession, { classSessionId: cls.id });
    advanceMin(h, 31);
    sweep(h);
    expect(h.db.classDocument.classSessionId.find(cls.id)).toBeFalsy();
  });
});

describe('lesson JSON retention (RETENTION_DAYS)', () => {
  function lessonRows(env: Record<string, string>) {
    const e = setup(env);
    const learner = makeLearner(e.h, e.client);
    const s = makeSession(e.h, e.client, learner.id);
    const now = e.h.clock.now();
    e.h.withReducerTx(TestAuth.internal(), ctx => {
      if (!ctx.db.lessonRecord.sessionId.find(s.id)) ctx.db.lessonRecord.insert({ sessionId: s.id, data: '{}' });
      ctx.db.lessonPlan.insert({ utteranceId: 3n, sessionId: s.id, request: '{}', meta: '{}', beats: '[]', scenes: '[]', version: 0, final: true });
      ctx.db.beat.insert({ id: 0n, sessionId: s.id, utteranceId: 3n, idx: 0, visual: '{}', narration: 'a', sentenceIdx: 0, canvasVersion: 1, createdAt: now });
    });
    const count = () => ({
      record: e.h.db.lessonRecord.sessionId.find(s.id) ? 1 : 0,
      plans: [...e.h.db.lessonPlan.sessionId.filter(s.id)].length,
      beats: [...e.h.db.beat.sessionId.filter(s.id)].length,
      turns: [...e.h.db.turn.sessionId.filter(s.id)].length,
    });
    studentSays(e.h, e.client, s.id, 'one half');
    return { ...e, s, count };
  }

  it('default off: kept forever', () => {
    const { h, client, s, count } = lessonRows({});
    call(h, client, mod.endSession, { sessionId: s.id });
    advanceMin(h, 60 * 24 * 365);
    sweep(h);
    expect(count()).toEqual({ record: 1, plans: 1, beats: 1, turns: 1 });
  });

  it('RETENTION_DAYS=2: deleted 2 days after the session ended; turns are kept', () => {
    const { h, client, s, count } = lessonRows({ RETENTION_DAYS: '2' });
    advanceMin(h, 60 * 24 * 5);
    sweep(h);
    expect(count().record).toBe(1); // active
    call(h, client, mod.endSession, { sessionId: s.id });
    advanceMin(h, 60 * 47);
    sweep(h);
    expect(count().record).toBe(1);
    advanceMin(h, 120);
    sweep(h);
    expect(count()).toEqual({ record: 0, plans: 0, beats: 0, turns: 1 });
    setEnvOverride(ENV);
  });
});
