// Identity and authorization (src/auth.ts): every client reducer/procedure, allowed and denied.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TimeDuration } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { AUTH_DEFAULTS as A, type IssueCodeResult } from '../../shared/src/auth';
import { sha256Hex } from '../src/sha256';
import { auth, call, makeLearner, makeSession, mod, proc, setup, type H } from './helpers';

type Env = ReturnType<typeof setup>;
type Who = ReturnType<typeof auth>;
const AUTH_ERR = /another device|another teacher|teachers only|not in one of your classes|simulated students are run/i;

function errorOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const denied = (fn: () => unknown) => expect(errorOf(fn)).toMatch(AUTH_ERR);
const allowed = (fn: () => unknown) => expect(errorOf(fn)).not.toMatch(AUTH_ERR);

function makeTeacher(h: H, who: Who, name = 'Ms. Park') {
  call(h, who, mod.createTeacher, { name });
  return [...h.db.teacher.iter()].filter(t => t.name === name).sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
}
const CLASS = { goals: 'fractions', content: 'adding fractions', delivery: '', documentName: '', documentMime: '', documentText: '', documentData: new Uint8Array(), simulatedCount: 0 };
function startClass(h: H, who: Who, teacherId: bigint) {
  call(h, who, mod.startClassSession, { teacherId, ...CLASS });
  return [...h.db.classSession.iter()].filter(c => c.teacherId === teacherId && c.active)[0]!;
}
const issue = (h: H, who: Who, kind: string, accountId: bigint, teacherId = 0n): IssueCodeResult =>
  JSON.parse((mod.issueSignInCode as any)(proc(h, who), { kind, accountId, teacherId }));
const redeem = (h: H, who: Who, code: string) => JSON.parse((mod.linkDevice as any)(proc(h, who), { code }));
const view = (h: H, who: Who, v: unknown) => (v as any)(h.viewContext(who as never), {}) as Array<{ id: bigint; name: string }>;
const anonView = (h: H, v: unknown) => (v as any)(h.anonymousViewContext(), {}) as Array<{ id: bigint; name: string }>;

function boardItem(h: H, sessionId: bigint): bigint {
  let id = 0n;
  h.withReducerTx(TestAuth.internal(), ctx => {
    id = ctx.db.boardItem.insert({
      id: 0n, sessionId, idx: 0, kind: 'plain', content: '{}', phase: 'explore', visible: true, utteranceId: 0n, sentenceIdx: 0,
      taskKey: '', answerState: 'open', lastAnswer: '', createdAt: ctx.timestamp, markerPos: -1,
    }).id;
  });
  return id;
}

describe('sha256', () => {
  it('matches node:crypto', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ünïcode ✓'.repeat(20)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('student reducers: own learner and own sessions only', () => {
  it('every session reducer is refused for another device and allowed for the owner', () => {
    const { h, client, agent } = setup();
    const stranger = auth('stranger');
    const l = makeLearner(h, client);
    const s = makeSession(h, client, l.id);
    const item = boardItem(h, s.id);
    const cases: Array<[string, (who: Who) => void]> = [
      ['uploadPhoto', who => call(h, who, mod.uploadPhoto, { sessionId: s.id, mime: 'image/png', data: new Uint8Array(4) })],
      ['attachImage', who => call(h, who, mod.attachImage, { sessionId: s.id, mime: 'image/png', data: new Uint8Array(4) })],
      ['removePendingImage', who => call(h, who, mod.removePendingImage, { sessionId: s.id })],
      ['pushAudio', who => call(h, who, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: new Uint8Array(32), final: false })],
      ['endTurn', who => call(h, who, mod.endTurn, { sessionId: s.id })],
      ['startConversation', who => call(h, who, mod.startConversation, { sessionId: s.id })],
      ['interrupt', who => call(h, who, mod.interrupt, { sessionId: s.id })],
      ['interruptUtterance', who => call(h, who, mod.interruptUtterance, { sessionId: s.id, utteranceId: 0n })],
      ['markPlayed', who => call(h, who, mod.markPlayed, { sessionId: s.id, utteranceId: 1n, idx: 0 })],
      ['submitGapAnswer', who => call(h, who, mod.submitGapAnswer, { boardItemId: item, answer: '3' })],
      ['reportNoise', who => call(h, who, mod.reportNoise, { sessionId: s.id, noiseDb: -50 })],
      ['setSessionVoice', who => call(h, who, mod.setSessionVoice, { sessionId: s.id, voice: false })],
      ['submitTextTurn', who => call(h, who, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' })],
      ['submitInteraction', who => call(h, who, mod.submitInteraction, { sessionId: s.id, kind: 'submit', payload: '{}' })],
      ['requestTutor', who => call(h, who, mod.requestTutor, { sessionId: s.id, kind: 'shear_feedback', payload: '{}' })],
      ['setPresence', who => call(h, who, mod.setPresence, { learnerId: l.id, status: 'waiting' })],
      ['startSession', who => call(h, who, mod.startSession, { learnerId: l.id, taskText: 'x' })],
    ];
    for (const [name, run] of cases) {
      expect(errorOf(() => run(stranger)), `${name} by a stranger`).toMatch(AUTH_ERR);
    }
    for (const [name, run] of cases) {
      expect(errorOf(() => run(client)), `${name} by the owner`).not.toMatch(AUTH_ERR);
    }
    // The agent (worker / operator) passes every check.
    const s2 = makeSession(h, client, l.id);
    allowed(() => call(h, agent, mod.submitTextTurn, { sessionId: s2.id, text: 'from the operator', intent: '' }));
    denied(() => call(h, stranger, mod.endSession, { sessionId: s2.id }));
    call(h, client, mod.endSession, { sessionId: s2.id });
    expect(h.db.session.id.find(s2.id)!.active).toBe(false);
  });

  it('a teacher cannot act as a student in their class session; the student can', () => {
    const { h, client } = setup();
    const teacherDevice = auth('teacher-device');
    const l = makeLearner(h, client);
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    const t = makeTeacher(h, teacherDevice);
    startClass(h, teacherDevice, t.id);
    const s = [...h.db.session.iter()].find(x => x.learnerId === l.id && x.active)!;
    expect(s.classSessionId).not.toBe(0n);
    denied(() => call(h, teacherDevice, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: '' }));
    denied(() => call(h, teacherDevice, mod.setPresence, { learnerId: l.id, status: 'offline' }));
    allowed(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: '' }));
  });

  it('simulated students: no client may drive them', () => {
    const { h, client } = setup({ ANTHROPIC_API_KEY: 'k' });
    const t = makeTeacher(h, client);
    call(h, client, mod.startClassSession, { teacherId: t.id, ...CLASS, simulatedCount: 1 });
    const sim = [...h.db.learner.iter()].find(l => l.isSimulated)!;
    const s = [...h.db.session.iter()].find(x => x.learnerId === sim.id && x.active)!;
    denied(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: '' }));
    denied(() => call(h, client, mod.setPresence, { learnerId: sim.id, status: 'offline' }));
    denied(() => call(h, client, mod.startSession, { learnerId: sim.id, taskText: 'x' }));
    expect(issue(h, client, 'learner', sim.id, t.id)).toMatchObject({ ok: false });
  });
});

describe('teacher reducers: own teacher and own class sessions only', () => {
  it('start / end / observe / refresh / reset / add student', () => {
    const { h, client } = setup();
    const teacherB = auth('teacher-b');
    const t = makeTeacher(h, client);
    makeTeacher(h, teacherB, 'Mr. B');
    denied(() => call(h, teacherB, mod.startClassSession, { teacherId: t.id, ...CLASS }));
    denied(() => call(h, teacherB, mod.startClassSessionWith, { teacherId: t.id, ...CLASS, resetSimulated: false }));
    const l = makeLearner(h, auth('kid'), 'Kim');
    const kid = auth('kid');
    call(h, kid, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    const cls = startClass(h, client, t.id);
    denied(() => call(h, teacherB, mod.setImpersonation, { classSessionId: cls.id, learnerId: l.id }));
    allowed(() => call(h, client, mod.setImpersonation, { classSessionId: cls.id, learnerId: l.id }));
    call(h, client, mod.setImpersonation, { classSessionId: cls.id, learnerId: 0n });
    expect(errorOf(() => (mod.refreshDashboard as any)(proc(h, teacherB), { classSessionId: cls.id }))).toMatch(/another teacher/);
    allowed(() => (mod.refreshDashboard as any)(proc(h, client, () => ({ status: 500, body: '{}' })), { classSessionId: cls.id }));
    denied(() => call(h, teacherB, mod.addStudent, { teacherId: t.id, name: 'Zed', age: 9, grade: 4, style: '' }));
    denied(() => call(h, auth('nobody'), mod.resetSimulatedStudents, { count: 1 }));
    denied(() => call(h, teacherB, mod.endClassSession, { classSessionId: cls.id }));
    expect(h.db.classSession.id.find(cls.id)!.active).toBe(true);
    call(h, client, mod.endClassSession, { classSessionId: cls.id });
    expect(h.db.classSession.id.find(cls.id)!.active).toBe(false);
    allowed(() => call(h, teacherB, mod.resetSimulatedStudents, { count: 1 }));
  });

  it('a class session puts its students on the teacher roster (profile + codes), not on other rosters', () => {
    const { h, client } = setup();
    const kid = auth('kid');
    const teacherB = auth('teacher-b');
    const l = makeLearner(h, kid, 'Kim');
    const t = makeTeacher(h, client);
    const tb = makeTeacher(h, teacherB, 'Mr. B');
    expect(issue(h, client, 'learner', l.id, t.id)).toMatchObject({ ok: false });
    call(h, kid, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    startClass(h, client, t.id);
    expect(view(h, client, mod.myStudents).map(x => x.id)).toEqual([l.id]);
    expect(view(h, teacherB, mod.myStudents)).toEqual([]);
    expect(issue(h, client, 'learner', l.id, t.id)).toMatchObject({ ok: true, kind: 'learner', name: 'Kim' });
    expect(issue(h, teacherB, 'learner', l.id, tb.id)).toMatchObject({ ok: false });
    // teacher B cannot pass teacher A's id either
    expect(issue(h, teacherB, 'learner', l.id, t.id)).toMatchObject({ ok: false });
  });
});

describe('accounts and sign-in codes', () => {
  it('created accounts belong to the creating device (views); agent-created ones to nobody', () => {
    const { h, client, agent } = setup();
    const other = auth('other');
    const l = makeLearner(h, client, 'Ava');
    const t = makeTeacher(h, client);
    expect(view(h, client, mod.myLearners).map(x => x.name)).toEqual(['Ava']);
    expect(view(h, client, mod.myTeachers).map(x => x.name)).toEqual(['Ms. Park']);
    expect(view(h, other, mod.myLearners)).toEqual([]);
    expect(view(h, other, mod.myTeachers)).toEqual([]);
    makeLearner(h, agent, 'Seeded');
    expect(view(h, agent, mod.myLearners)).toEqual([]);
    expect(l.id).toBeTruthy();
    expect(t.id).toBeTruthy();
    // Nothing is claimable in a database created with authorization.
    expect(anonView(h, mod.claimableLearners)).toEqual([]);
  });

  it('teacher: sign in on another device with a one-time code', () => {
    const { h, client } = setup();
    const laptop = auth('laptop');
    const t = makeTeacher(h, client);
    expect(issue(h, laptop, 'teacher', t.id)).toMatchObject({ ok: false });
    const r = issue(h, client, 'teacher', t.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.code).toMatch(new RegExp(`^[${A.CODE_ALPHABET}]{${A.CODE_LENGTH}}$`));
    expect(r.expiresMs - Number(h.clock.now().microsSinceUnixEpoch / 1000n)).toBe(A.DEVICE_CODE_TTL_S * 1000);
    // Only the hash is stored.
    const rows = [...h.db.signInCode.iter()];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(r.code);
    // Lowercase and a dash are fine.
    const typed = `${r.code.slice(0, 3).toLowerCase()}-${r.code.slice(3)}`;
    expect(redeem(h, laptop, typed)).toEqual({ ok: true, kind: 'teacher', accountId: String(t.id), name: 'Ms. Park' });
    expect(view(h, laptop, mod.myTeachers).map(x => x.id)).toEqual([t.id]);
    allowed(() => startClass(h, laptop, t.id));
    // One-time.
    expect(redeem(h, auth('third'), r.code)).toMatchObject({ ok: false });
  });

  it('codes expire', () => {
    const { h, client } = setup();
    const t = makeTeacher(h, client);
    const r = issue(h, client, 'teacher', t.id);
    if (!r.ok) throw new Error(r.error);
    h.clock.advance(TimeDuration.fromMillis((A.DEVICE_CODE_TTL_S + 1) * 1000));
    expect(redeem(h, auth('late'), r.code)).toMatchObject({ ok: false });
  });

  it('student: the teacher adds a student and hands out a code; the child redeems it', () => {
    const { h, client } = setup();
    const child = auth('child-tablet');
    const t = makeTeacher(h, client);
    call(h, client, mod.addStudent, { teacherId: t.id, name: 'Leo', age: 8, grade: 3, style: '' });
    const leo = [...h.db.learner.iter()].find(l => l.name === 'Leo')!;
    // The teacher's own device is not signed in as Leo.
    expect(view(h, client, mod.myLearners)).toEqual([]);
    expect(view(h, client, mod.myStudents).map(x => x.name)).toEqual(['Leo']);
    denied(() => call(h, client, mod.startSession, { learnerId: leo.id, taskText: 'x' }));
    const r = issue(h, client, 'learner', leo.id, t.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.expiresMs - Number(h.clock.now().microsSinceUnixEpoch / 1000n)).toBe(A.STUDENT_CODE_TTL_S * 1000);
    expect(redeem(h, child, r.code)).toMatchObject({ ok: true, kind: 'learner', name: 'Leo' });
    expect(view(h, child, mod.myLearners).map(x => x.name)).toEqual(['Leo']);
    allowed(() => call(h, child, mod.startSession, { learnerId: leo.id, taskText: 'x' }));
    // The child's device may make a code for yet another device of its own.
    expect(issue(h, child, 'learner', leo.id)).toMatchObject({ ok: true });
  });

  it('wrong codes are throttled per identity (failures are committed)', () => {
    const { h, client } = setup();
    const t = makeTeacher(h, client);
    const r = issue(h, client, 'teacher', t.id);
    if (!r.ok) throw new Error(r.error);
    const guesser = auth('guesser');
    for (let i = 0; i < A.MAX_FAILED_ATTEMPTS; i++) expect(redeem(h, guesser, 'ZZZZZZ')).toMatchObject({ ok: false, error: expect.stringMatching(/not valid/) });
    expect(redeem(h, guesser, r.code)).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
    h.clock.advance(TimeDuration.fromMillis(A.ATTEMPT_WINDOW_S * 1000 + 1));
    const fresh = issue(h, client, 'teacher', t.id);
    if (!fresh.ok) throw new Error(fresh.error);
    expect(redeem(h, guesser, fresh.code)).toMatchObject({ ok: true });
  });

  it('at most MAX_LIVE_CODES_PER_ACCOUNT live codes per account; the agent can issue for anyone', () => {
    const { h, client, agent } = setup();
    const t = makeTeacher(h, agent, 'Seeded T');
    const codes: string[] = [];
    for (let i = 0; i < A.MAX_LIVE_CODES_PER_ACCOUNT + 2; i++) {
      const r = issue(h, agent, 'teacher', t.id);
      if (!r.ok) throw new Error(r.error);
      codes.push(r.code);
    }
    expect([...h.db.signInCode.iter()]).toHaveLength(A.MAX_LIVE_CODES_PER_ACCOUNT);
    expect(redeem(h, client, codes[0]!)).toMatchObject({ ok: false });
    expect(redeem(h, client, codes.at(-1)!)).toMatchObject({ ok: true, name: 'Seeded T' });
  });

  it('forgetAccount: sign out on this device, but never lose the last device of a teacher', () => {
    const { h, client } = setup();
    const t = makeTeacher(h, client);
    expect(() => call(h, client, mod.forgetAccount, { kind: 'teacher', accountId: t.id })).toThrow(/only device/);
    const r = issue(h, client, 'teacher', t.id);
    if (!r.ok) throw new Error(r.error);
    const laptop = auth('laptop');
    redeem(h, laptop, r.code);
    call(h, client, mod.forgetAccount, { kind: 'teacher', accountId: t.id });
    expect(view(h, client, mod.myTeachers)).toEqual([]);
    denied(() => startClass(h, client, t.id));
  });

  it('legacy accounts (before authorization) are claimable once; newer unowned ones are not', () => {
    const { h, client, agent } = setup();
    // Simulate a database from before: drop the auth_meta row and the link of an old learner.
    const old = makeLearner(h, client, 'Old');
    const seeded = makeLearner(h, agent, 'Seeded');
    h.withReducerTx(TestAuth.internal(), ctx => {
      for (const l of [...ctx.db.accountLink.iter()]) ctx.db.accountLink.id.delete(l.id);
      ctx.db.authMeta.id.delete(0);
    });
    h.clock.advance(TimeDuration.fromMillis(1000));
    h.withReducerTx(TestAuth.internal(), ctx => (mod.onConnect as any)(ctx, {}));
    const newer = makeLearner(h, agent, 'Newer');
    expect(anonView(h, mod.claimableLearners).map(l => l.name).sort()).toEqual(['Old', 'Seeded']);
    const someone = auth('someone');
    call(h, someone, mod.claimAccount, { kind: 'learner', accountId: old.id });
    expect(view(h, someone, mod.myLearners).map(l => l.name)).toEqual(['Old']);
    expect(() => call(h, auth('late'), mod.claimAccount, { kind: 'learner', accountId: old.id })).toThrow(/another device/);
    expect(() => call(h, someone, mod.claimAccount, { kind: 'learner', accountId: newer.id })).toThrow(/another device/);
    expect(anonView(h, mod.claimableLearners).map(l => l.name)).toEqual(['Seeded']);
    expect(seeded.id).toBeTruthy();
  });
});

describe('scheduled functions: scheduler only (client-callable in 2.13)', () => {
  const job = { scheduledId: 1n, scheduledAt: { tag: 'Time', value: 0n }, sessionId: 1n, classSessionId: 1n };
  const procedures: Array<[string, unknown]> = [
    ['transcribePhrase', mod.transcribePhrase],
    ['synthesizeSentence', mod.synthesizeSentence],
    ['extractMemory', mod.extractMemory],
    ['summarizeSession', mod.summarizeSession],
    ['dashboardTick', mod.dashboardTick],
    ['simStudentTurn', mod.simStudentTurn],
  ];
  it.each(procedures)('%s refuses a client and the agent', (_name, fn) => {
    const { h, client, agent } = setup();
    for (const who of [client, agent]) expect(() => (fn as any)(proc(h, who), { job })).toThrow(/scheduler only/);
  });
  it('finishTextSentence (scheduled reducer) refuses a client and the agent', () => {
    const { h, client, agent } = setup();
    for (const who of [client, agent]) expect(() => call(h, who, mod.finishTextSentence as any, { job: { ...job, sentenceId: 1n, utteranceId: 1n, idx: 0 } })).toThrow(/scheduler only/);
  });
});
