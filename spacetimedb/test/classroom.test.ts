import { ScheduleAt } from 'spacetimedb';
import { describe, it, expect } from 'vitest';
import { TimeDuration } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { CLASSROOM_DEFAULTS as C } from '../../shared/src/config';
import { SIM_STUDENTS } from '../../shared/src/classroom/simStudents';
import { clusterViolations } from '../../shared/src/classroom/clusters';
import { cleanChildMessage, pickBehaviour, resetClusterBackfill } from '../src/classroom';
import { anthropicResponse, auth, call, makeLearner, makeSession, mod, proc, runExtraction, runTextPlay, session, setup, turns, type H, type Req, type Responder } from './helpers';

type Env = ReturnType<typeof setup>;
const ANTHROPIC = { ANTHROPIC_API_KEY: 'anthropic-test' };
const at = (j: any): bigint => (typeof j.scheduledAt.value === 'bigint' ? j.scheduledAt.value : j.scheduledAt.value.microsSinceUnixEpoch);
const now = (h: H) => h.clock.now().microsSinceUnixEpoch;
const advance = (h: H, s: number) => h.clock.advance(TimeDuration.fromMillis(s * 1000));

function teacher(env: Env, name = 'Ms. Park') {
  call(env.h, env.client, mod.createTeacher, { name });
  return [...env.h.db.teacher.iter()].find(t => t.name === name)!;
}

function startClass(env: Env, teacherId: bigint, over: Partial<Parameters<typeof mod.startClassSession>[1] & object> = {}) {
  call(env.h, env.client, mod.startClassSession, {
    teacherId,
    goals: 'Understand why 1/4 + 2/4 = 3/4',
    content: 'Adding fractions with the same denominator',
    delivery: 'Use pizza pictures, short steps',
    documentName: '',
    documentMime: '',
    documentText: '',
    documentData: new Uint8Array(),
    simulatedCount: 0,
    ...over,
  } as never);
  return [...env.h.db.classSession.iter()].filter(c => c.teacherId === teacherId && c.active)[0]!;
}

const linked = (h: H, classId: bigint) => [...h.db.session.iter()].filter(s => s.classSessionId === classId && s.active).sort((a, b) => (a.id < b.id ? -1 : 1));
const simLearners = (h: H) => [...h.db.learner.iter()].filter(l => l.isSimulated).sort((a, b) => a.simRank - b.simRank);
const presenceOf = (h: H, learnerId: bigint) => h.db.presence.learnerId.find(learnerId)?.status;

/** The worker's side: the tutor answers (opening or the latest student turn) and the text is read. */
let utt = 1000n;
function tutorReplies(env: Env, sessionId: bigint, text = 'What is one quarter plus two quarters?') {
  const { h, agent } = env;
  const u = ++utt;
  const s = session(h, sessionId);
  const ts = turns(h, sessionId);
  if (ts.length === 0) call(h, agent, mod.beginOpening, { sessionId, utteranceId: u });
  else call(h, agent, mod.beginUtterance, { sessionId, utteranceId: u, replyToIdx: ts[ts.length - 1]!.idx, preemptive: false });
  call(h, agent, mod.addSentence, { sessionId, utteranceId: u, idx: 0, display: text, speech: text });
  call(h, agent, mod.appendTutorTurn, { sessionId, utteranceId: u, text, interrupted: false });
  runTextPlay(h);
  expect(session(h, sessionId).turnState, `s${s.id} back to listening`).toBe('listening');
}

/** Pops due sim jobs and runs them with the responder. */
function runSim(h: H, responder?: Responder, dueOnly = false): number {
  const jobs = [...h.db.simTurnJob.iter()].filter(j => !dueOnly || at(j) <= now(h));
  h.withReducerTx(TestAuth.internal(), ctx => {
    for (const j of jobs) ctx.db.simTurnJob.scheduledId.delete(j.scheduledId);
  });
  for (const job of jobs) (mod.simStudentTurn as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}

function runDashboardJobs(h: H, responder?: Responder): number {
  const jobs = [...h.db.dashboardJob.iter()];
  h.withReducerTx(TestAuth.internal(), ctx => {
    for (const j of jobs) ctx.db.dashboardJob.scheduledId.delete(j.scheduledId);
  });
  for (const job of jobs) (mod.dashboardTick as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}

const simSays = (msg: string): Responder => () => anthropicResponse({ message: msg });

// ---------------------------------------------------------------- presence & teachers

describe('teachers and presence', () => {
  it('createTeacher validates the name', () => {
    const env = setup();
    teacher(env);
    expect([...env.h.db.teacher.iter()]).toHaveLength(1);
    expect(() => call(env.h, env.client, mod.createTeacher, { name: '  ' })).toThrow(/1-60/);
  });

  it('setPresence validates; disconnect marks only that connection’s real learners offline', () => {
    const env = setup();
    const { h } = env;
    const a = makeLearner(h, env.client, 'Ada');
    const b = makeLearner(h, env.client, 'Ben');
    const other = auth('other-tab');
    call(h, env.client, mod.setPresence, { learnerId: a.id, status: 'waiting' });
    // Same identity (device), another connection: the presence remembers that connection.
    const otherConn = Object.assign(Object.create(Object.getPrototypeOf(env.client)), env.client, { connectionId: other.connectionId });
    call(h, otherConn, mod.setPresence, { learnerId: b.id, status: 'in_session' });
    expect(() => call(h, other, mod.setPresence, { learnerId: b.id, status: 'waiting' })).toThrow(/another device/);
    expect(() => call(h, env.client, mod.setPresence, { learnerId: a.id, status: 'asleep' })).toThrow(/status must be/);
    expect(() => call(h, env.client, mod.setPresence, { learnerId: 999n, status: 'waiting' })).toThrow(/not found/);
    expect(h.db.presence.learnerId.find(a.id)!.connectionId).toBe(env.client.connectionId!.toHexString());

    h.withReducerTx(env.client, ctx => (mod.onDisconnect as any)(ctx, {}));
    expect(presenceOf(h, a.id)).toBe('offline');
    expect(presenceOf(h, b.id)).toBe('in_session');
  });

  it('simulated learners stay online when a connection drops', () => {
    const env = setup(ANTHROPIC);
    const t = teacher(env);
    startClass(env, t.id, { simulatedCount: 2 });
    env.h.withReducerTx(env.client, ctx => (mod.onDisconnect as any)(ctx, {}));
    for (const l of simLearners(env.h)) expect(presenceOf(env.h, l.id)).toBe('in_session');
  });
});

// ---------------------------------------------------------------- class sessions

describe('startClassSession', () => {
  it('moves every online student (waiting or in a session) into a new linked session; offline students stay out', () => {
    const env = setup();
    const { h, client } = env;
    const t = teacher(env);
    const waiting = makeLearner(h, client, 'Wanda');
    const busy = makeLearner(h, client, 'Bruno');
    const offline = makeLearner(h, client, 'Olga');
    call(h, client, mod.setPresence, { learnerId: waiting.id, status: 'waiting' });
    const adhoc = makeSession(h, client, busy.id);
    call(h, client, mod.setSessionVoice, { sessionId: adhoc.id, voice: false });
    call(h, client, mod.setPresence, { learnerId: busy.id, status: 'in_session' });
    call(h, client, mod.setPresence, { learnerId: offline.id, status: 'offline' });

    const cls = startClass(env, t.id);
    const ls = linked(h, cls.id);
    expect(ls.map(s => s.learnerId).sort()).toEqual([waiting.id, busy.id].sort());
    expect(session(h, adhoc.id).active).toBe(false); // ad-hoc session ended
    expect(ls.find(s => s.learnerId === busy.id)!.voice).toBe(false); // keeps text mode
    expect(ls.find(s => s.learnerId === waiting.id)!.voice).toBe(true);
    expect(ls[0]!.taskText).toBe('Adding fractions with the same denominator');
    expect(presenceOf(h, waiting.id)).toBe('in_session');
    expect(presenceOf(h, busy.id)).toBe('in_session');
    expect([...h.db.session.iter()].some(s => s.learnerId === offline.id)).toBe(false);
    expect(h.db.dashboardState.classSessionId.find(cls.id)).toMatchObject({ impersonatingLearnerId: 0n, running: false });
    const [job] = [...h.db.dashboardJob.iter()];
    expect(at(job) - now(h)).toBe(BigInt(C.DASHBOARD_INTERVAL_S) * 1_000_000n);
  });

  it("ends the teacher's previous class session; students of it move into the new one", () => {
    const env = setup();
    const { h, client } = env;
    const t = teacher(env);
    const l = makeLearner(h, client, 'Ida');
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    const first = startClass(env, t.id);
    const firstSession = linked(h, first.id)[0]!;
    const second = startClass(env, t.id, { goals: 'Compare fractions' });
    expect(h.db.classSession.id.find(first.id)!.active).toBe(false);
    expect(session(h, firstSession.id).active).toBe(false);
    expect(linked(h, second.id).map(s => s.learnerId)).toEqual([l.id]);
    expect([...h.db.dashboardJob.iter()].every(j => j.classSessionId === second.id)).toBe(true);
  });

  it('teacher instructions and Markdown document enter buildContext; image documents reach getSessionImage', () => {
    const env = setup();
    const { h, client, agent } = env;
    const t = teacher(env);
    const l = makeLearner(h, client, 'Mo');
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    const cls = startClass(env, t.id, { documentName: 'sheet.md', documentMime: 'text/markdown', documentText: '# Worksheet\n1. 1/4 + 2/4' });
    const s = linked(h, cls.id)[0]!;
    const ctxText = (mod.buildContext as any)(proc(h, agent), { sessionId: s.id }) as string;
    expect(ctxText).toContain('Learning goals: Understand why 1/4 + 2/4 = 3/4');
    expect(ctxText).toContain('How to teach (delivery): Use pizza pictures');
    expect(ctxText).toContain('# Worksheet');
    expect(ctxText).toContain('Ms. Park');

    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const cls2 = startClass(env, t.id, { documentName: 'board.png', documentMime: 'image/png', documentData: png });
    const s2 = linked(h, cls2.id)[0]!;
    expect(s2.hasImage).toBe(true);
    const img = (mod.getSessionImage as any)(proc(h, agent), { sessionId: s2.id }) as string;
    expect(img).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    const ctx2 = (mod.buildContext as any)(proc(h, agent), { sessionId: s2.id }) as string;
    expect(ctx2).toContain('an image, attached to your first message');
    expect(ctx2).not.toContain('A photo of the task was uploaded');
    // Ad-hoc sessions are unaffected.
    const adhoc = makeSession(h, client, makeLearner(h, client, 'Zed').id);
    expect((mod.buildContext as any)(proc(h, agent), { sessionId: adhoc.id })).not.toContain('Class session');
  });

  it('rejects bad documents and too many simulated students', () => {
    const env = setup();
    const t = teacher(env);
    expect(() => startClass(env, t.id, { documentMime: 'application/pdf', documentText: 'x' })).toThrow(/document must be/);
    expect(() => startClass(env, t.id, { documentMime: 'image/png' })).toThrow(/without data/);
    expect(() => startClass(env, t.id, { simulatedCount: 21 })).toThrow(/at most 20/);
    expect(() => startClass(env, 99n)).toThrow(/teacher 99 not found/);
  });

  it('endClassSession ends linked sessions, real students back to waiting, simulated ones offline', () => {
    const env = setup(ANTHROPIC);
    const { h, client } = env;
    const t = teacher(env);
    const l = makeLearner(h, client, 'Rae');
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    const cls = startClass(env, t.id, { simulatedCount: 2 });
    expect(linked(h, cls.id)).toHaveLength(3);
    call(h, client, mod.endClassSession, { classSessionId: cls.id });
    expect(linked(h, cls.id)).toHaveLength(0);
    expect(h.db.classSession.id.find(cls.id)!.active).toBe(false);
    expect(presenceOf(h, l.id)).toBe('waiting');
    for (const s of simLearners(h)) expect(presenceOf(h, s.id)).toBe('offline');
    expect([...h.db.dashboardJob.iter()]).toHaveLength(0);
    expect([...h.db.simTurnJob.iter()]).toHaveLength(0);
  });
});

describe('late joiners (class session already active)', () => {
  it('a real student who goes waiting during an active class is linked at once; voice/text mode kept', () => {
    const env = setup(ANTHROPIC);
    const { h, client } = env;
    const t = teacher(env);
    const cls = startClass(env, t.id, { simulatedCount: 2 });
    expect(linked(h, cls.id)).toHaveLength(2);

    const late = makeLearner(h, client, 'Lena');
    call(h, client, mod.setPresence, { learnerId: late.id, status: 'waiting' });
    const mine = linked(h, cls.id).filter(s => s.learnerId === late.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.voice).toBe(true);
    expect(mine[0]!.taskText).toBe('Adding fractions with the same denominator');
    expect(presenceOf(h, late.id)).toBe('in_session');

    // Re-asserting `waiting` (hidden tab becomes visible) does not create another session.
    call(h, client, mod.setPresence, { learnerId: late.id, status: 'waiting' });
    expect(linked(h, cls.id).filter(s => s.learnerId === late.id).map(s => s.id)).toEqual([mine[0]!.id]);

    // A typed ad-hoc session that switches to "wait for my teacher" joins in text mode.
    const typed = makeLearner(h, client, 'Tom');
    const adhoc = makeSession(h, client, typed.id);
    call(h, client, mod.setSessionVoice, { sessionId: adhoc.id, voice: false });
    call(h, client, mod.setPresence, { learnerId: typed.id, status: 'waiting' });
    expect(session(h, adhoc.id).active).toBe(false);
    expect(linked(h, cls.id).find(s => s.learnerId === typed.id)!.voice).toBe(false);
  });

  it('an explicit ad-hoc session ("learn by myself") during an active class stays ad-hoc', () => {
    const env = setup();
    const { h, client } = env;
    const cls = startClass(env, teacher(env).id);
    const solo = makeLearner(h, client, 'Sol');
    const adhoc = makeSession(h, client, solo.id);
    call(h, client, mod.setPresence, { learnerId: solo.id, status: 'in_session' });
    expect(session(h, adhoc.id)).toMatchObject({ active: true, classSessionId: 0n });
    expect(linked(h, cls.id)).toHaveLength(0);
  });

  it('nothing happens without an active class; the newest active class wins; ended class -> waiting stays', () => {
    const env = setup();
    const { h, client } = env;
    const l = makeLearner(h, client, 'Nia');
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    expect([...h.db.session.iter()].some(s => s.learnerId === l.id)).toBe(false);
    expect(presenceOf(h, l.id)).toBe('waiting');

    const a = startClass(env, teacher(env, 'Mr. A').id); // Nia joins at start
    expect(linked(h, a.id).map(s => s.learnerId)).toEqual([l.id]);
    call(h, client, mod.endClassSession, { classSessionId: a.id });
    expect(presenceOf(h, l.id)).toBe('waiting'); // module-written waiting does not re-link
    expect([...h.db.session.iter()].filter(s => s.learnerId === l.id && s.active)).toHaveLength(0);

    const other = makeLearner(h, client, 'Oli');
    const b = startClass(env, teacher(env, 'Ms. B').id); // Nia (waiting) joins b
    const c = startClass(env, teacher(env, 'Dr. C').id); // Nia moves to c (newest)
    expect(linked(h, b.id)).toHaveLength(0);
    call(h, client, mod.setPresence, { learnerId: other.id, status: 'waiting' });
    expect(linked(h, c.id).map(s => s.learnerId).sort()).toEqual([l.id, other.id].sort());
    // A student already in an active class is not moved by a repeated `waiting`.
    const before = linked(h, c.id).find(s => s.learnerId === l.id)!.id;
    call(h, client, mod.setPresence, { learnerId: l.id, status: 'waiting' });
    expect(linked(h, c.id).find(s => s.learnerId === l.id)!.id).toBe(before);
  });
});

// ---------------------------------------------------------------- simulation

describe('simulation', () => {
  it('loads the 20 seed profiles in init', () => {
    const env = setup();
    const rows = [...env.h.db.simProfile.iter()].sort((a, b) => a.rank - b.rank);
    expect(rows.map(r => r.name)).toEqual(SIM_STUDENTS.map(s => s.name));
  });

  it('uses simulation users 1..n in seed order, text mode, seed memory, tutor speaks first', () => {
    const env = setup(ANTHROPIC);
    const { h } = env;
    const cls = startClass(env, teacher(env).id, { simulatedCount: 3 });
    const sims = simLearners(h);
    expect(sims.map(l => [l.simRank, l.name])).toEqual(SIM_STUDENTS.slice(0, 3).map(s => [s.rank, s.name]));
    for (const l of sims) {
      expect([...h.db.memoryNote.learnerId.filter(l.id)]).toHaveLength(SIM_STUDENTS[l.simRank - 1]!.memory.length);
      expect(presenceOf(h, l.id)).toBe('in_session');
    }
    const ls = linked(h, cls.id);
    expect(ls).toHaveLength(3);
    for (const s of ls) {
      expect(s.voice).toBe(false);
      expect(s.turnState).toBe('thinking'); // opening requested
    }
    expect(h.db.classSession.id.find(cls.id)).toMatchObject({ simulation: true, simulatedCount: 3 });
  });

  it('a new run resets the users (sessions, turns, notes, concept states deleted; learners recreated); users beyond n leave', () => {
    const env = setup(ANTHROPIC);
    const { h } = env;
    const t = teacher(env);
    const cls = startClass(env, t.id, { simulatedCount: 3 });
    const s1 = linked(h, cls.id)[0]!;
    tutorReplies(env, s1.id);
    runSim(h, simSays('is it 3/8?'));
    tutorReplies(env, s1.id, 'Not quite. Look at the slices.');
    const oldLearner = s1.learnerId;
    h.withReducerTx(TestAuth.internal(), ctx => {
      ctx.db.conceptState.insert({ id: 0n, learnerId: oldLearner, category: 'fractions', concept: 'fractions-add-same', mastery: 30, updatedAt: ctx.timestamp });
      ctx.db.memoryNote.insert({ id: 0n, learnerId: oldLearner, kind: 'quote', category: 'fractions', concept: '', text: 'new note', outcome: 'unknown', confidence: 1, reinforced: 0, createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
    });
    expect(turns(h, s1.id).length).toBe(3);

    const cls2 = startClass(env, t.id, { simulatedCount: 2 });
    expect(h.db.learner.id.find(oldLearner)).toBeFalsy();
    expect(h.db.session.id.find(s1.id)).toBeFalsy();
    expect(turns(h, s1.id)).toHaveLength(0);
    expect([...h.db.conceptState.learnerId.filter(oldLearner)]).toHaveLength(0);
    expect([...h.db.memoryNote.learnerId.filter(oldLearner)]).toHaveLength(0);
    const sims = simLearners(h);
    expect(sims.map(l => l.simRank)).toEqual([1, 2, 3]);
    const first = sims.find(l => l.simRank === 1)!;
    expect([...h.db.memoryNote.learnerId.filter(first.id)].map(n => n.text)).toEqual(SIM_STUDENTS[0]!.memory.map(m => m.text));
    expect(linked(h, cls2.id).map(s => s.learnerId).sort()).toEqual(sims.filter(l => l.simRank <= 2).map(l => l.id).sort());
    const third = sims.find(l => l.simRank === 3)!;
    expect(presenceOf(h, third.id)).toBe('offline');
    expect([...h.db.session.learnerId.filter(third.id)].some(s => s.active)).toBe(false);
  });

  it('schedules the student 2-5 s after each tutor reply; the message becomes a sim text turn', () => {
    const env = setup(ANTHROPIC);
    const { h } = env;
    const cls = startClass(env, teacher(env).id, { simulatedCount: 1 });
    const s = linked(h, cls.id)[0]!;
    expect([...h.db.simTurnJob.iter()]).toHaveLength(0); // tutor has not spoken
    tutorReplies(env, s.id);
    const jobs = [...h.db.simTurnJob.iter()];
    expect(jobs).toHaveLength(1);
    const delay = Number(at(jobs[0]) - now(h)) / 1e6;
    expect(delay).toBeGreaterThanOrEqual(C.SIM_DELAY_MIN_S);
    expect(delay).toBeLessThanOrEqual(C.SIM_DELAY_MAX_S);

    let req: Req | undefined;
    runSim(h, r => ((req = r), anthropicResponse({ message: '  umm 3/8?? ' })));
    const body = JSON.parse(req!.text);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.output_config.effort).toBe(C.SIM_EFFORT);
    expect(body.system).toContain('Mia');
    expect(body.system).toContain('Adds fractions by adding tops and bottoms');
    expect(body.messages[0].content).toContain('Tutor: What is one quarter plus two quarters?');
    const last = turns(h, s.id).slice(-1)[0]!;
    expect(last).toMatchObject({ role: 'student', text: 'umm 3/8??', source: 'sim', status: 'ready' });
    expect(session(h, s.id).turnState).toBe('thinking');
    expect([...h.db.simTurnJob.iter()]).toHaveLength(0); // waits for the next tutor reply
    expect([...h.db.simRunning.iter()]).toHaveLength(0);
  });

  it('stops at SIM_MAX_TURNS student turns per session', () => {
    const env = setup({ ...ANTHROPIC, SIM_MAX_TURNS: '2' });
    const { h } = env;
    const cls = startClass(env, teacher(env).id, { simulatedCount: 1 });
    const s = linked(h, cls.id)[0]!;
    for (let i = 0; i < 2; i++) {
      tutorReplies(env, s.id);
      expect(runSim(h, simSays(`answer ${i}`))).toBe(1);
    }
    tutorReplies(env, s.id, 'Great work today!');
    expect([...h.db.simTurnJob.iter()]).toHaveLength(0);
    expect(turns(h, s.id).filter(t => t.source === 'sim').map(t => t.text)).toEqual(['answer 0', 'answer 1']);
  });

  it('caps concurrent student-LLM calls: a busy job is re-queued without an HTTP call', () => {
    const env = setup(ANTHROPIC);
    const { h } = env;
    const cls = startClass(env, teacher(env).id, { simulatedCount: 1 });
    const s = linked(h, cls.id)[0]!;
    tutorReplies(env, s.id);
    h.withReducerTx(TestAuth.internal(), ctx => {
      for (let i = 0; i < C.SIM_MAX_CONCURRENT; i++) ctx.db.simRunning.insert({ sessionId: 900n + BigInt(i), startedAt: ctx.timestamp });
    });
    runSim(h); // no responder: an HTTP call would throw
    const [job] = [...h.db.simTurnJob.iter()];
    expect(job).toMatchObject({ sessionId: s.id, attempt: 1 });
    // Stale markers (crashed runs) stop counting.
    advance(h, C.SIM_RUNNING_STALE_S + 1);
    runSim(h, simSays('ok'));
    expect(turns(h, s.id).slice(-1)[0]!.text).toBe('ok');
    expect([...h.db.simRunning.iter()]).toHaveLength(0);
  });

  it('drops a stale job (the session moved on) and retries a failed call', () => {
    const env = setup(ANTHROPIC);
    const { h, client } = env;
    const cls = startClass(env, teacher(env).id, { simulatedCount: 1 });
    const s = linked(h, cls.id)[0]!;
    tutorReplies(env, s.id);
    call(h, env.agent, mod.submitTextTurn, { sessionId: s.id, text: 'operator typed for the student', intent: '' });
    runSim(h); // stale: turnCount changed -> no HTTP
    expect(turns(h, s.id).filter(t => t.source === 'sim')).toHaveLength(0);

    tutorReplies(env, s.id);
    runSim(h, () => ({ status: 529, body: '{"error":{"type":"overloaded_error","message":"busy"}}' }));
    const [retry] = [...h.db.simTurnJob.iter()];
    expect(retry).toMatchObject({ attempt: 1 });
    expect(Number(at(retry) - now(h)) / 1e6).toBe(C.SIM_FAILURE_RETRY_S);
    expect([...h.db.simRunning.iter()]).toHaveLength(0);
  });

  it('child messages lose emoji and markdown', () => {
    expect(cleanChildMessage('um.. step by step? ok 🙂 **3/8**  ')).toBe('um.. step by step? ok 3/8');
  });

  it('behaviour mix covers mistakes, questions, hesitation and correct answers', () => {
    expect(pickBehaviour(0)).toBe('mistake');
    expect(pickBehaviour(0.35)).toBe('question');
    expect(pickBehaviour(0.5)).toBe('unsure');
    expect(pickBehaviour(0.99)).toBe('correct');
  });
});

// ---------------------------------------------------------------- dashboard

function classWithSims(n: number, env = setup(ANTHROPIC)) {
  const cls = startClass(env, teacher(env).id, { simulatedCount: n });
  const ids = linked(env.h, cls.id).map(s => String(s.learnerId));
  return { env, h: env.h, cls, ids };
}

const dashboardAnswer = (summary: string, clusters: Array<{ name: string; ids: string[] }>): Responder => () =>
  anthropicResponse({ classSummary: summary, clusters: clusters.map(c => ({ name: c.name, description: `${c.name} status`, learnerIds: c.ids })) });

const clustersOf = (h: H, classId: bigint) =>
  [...h.db.studentCluster.classSessionId.filter(classId)].sort((a, b) => a.position - b.position).map(c => ({ name: c.name, ids: JSON.parse(c.learnerIds) as string[] }));

describe('student_cluster.members (typed learner ids)', () => {
  it('written with learnerIds; older rows are backfilled once on connect', () => {
    const { h, env, cls, ids } = classWithSims(4);
    (mod.refreshDashboard as any)(proc(h, env.client, dashboardAnswer('s', [{ name: 'A', ids: ids.slice(0, 2) }, { name: 'B', ids: ids.slice(2) }])), { classSessionId: cls.id });
    const rows = [...h.db.studentCluster.classSessionId.filter(cls.id)].sort((a, b) => a.position - b.position);
    expect(rows.map(r => r.members.map(String))).toEqual([ids.slice(0, 2), ids.slice(2)]);
    // A row as an older module wrote it (members defaulted to []).
    h.withReducerTx(TestAuth.internal(), ctx => ctx.db.studentCluster.id.update({ ...rows[0]!, members: [] }));
    resetClusterBackfill();
    h.withReducerTx(env.client, ctx => (mod.onConnect as any)(ctx, {}));
    expect(h.db.studentCluster.id.find(rows[0]!.id)!.members.map(String)).toEqual(ids.slice(0, 2));
  });
});

describe('dashboard', () => {
  it('refresh writes summary + valid clusters and books the next run in 30 s', () => {
    const { h, env, cls, ids } = classWithSims(6);
    let req: Req | undefined;
    const out = (
      (mod.refreshDashboard as any)(
        proc(h, env.client, r => {
          req = r;
          return dashboardAnswer('Most add the bottoms.', [
            { name: 'Adding bottoms', ids: ids.slice(0, 4) },
            { name: 'On track', ids: ids.slice(4) },
          ])(r, h);
        }),
        { classSessionId: cls.id }
      )
    );
    expect(out).toMatchObject({ ok: true, repaired: false, clusters: 2 });
    const user = JSON.parse(req!.text).messages[0].content as string;
    expect(user).toContain('every cluster has exactly 2 or 4 students');
    for (const s of SIM_STUDENTS.slice(0, 6)) expect(user).toContain(s.name);
    expect(user).toContain('Memory notes:');
    expect(h.db.classSummary.classSessionId.find(cls.id)).toMatchObject({ summary: 'Most add the bottoms.', version: 1 });
    expect(clustersOf(h, cls.id).map(c => c.ids.length)).toEqual([4, 2]);
    const st = h.db.dashboardState.classSessionId.find(cls.id)!;
    expect(st.running).toBe(false);
    expect(st.lastRunAt).toBeTruthy();
    expect(st.nextDueAt.microsSinceUnixEpoch - now(h)).toBe(BigInt(C.DASHBOARD_INTERVAL_S) * 1_000_000n);
    const jobs = [...h.db.dashboardJob.iter()];
    expect(jobs).toHaveLength(1);
    expect(at(jobs[0])).toBe(st.nextDueAt.microsSinceUnixEpoch);
  });

  it('prompt passes names (ids only in the roster); ids the LLM writes into prose are stripped', () => {
    const { h, env, cls, ids } = classWithSims(4);
    const names = SIM_STUDENTS.slice(0, 4).map(s => s.name);
    const first = names.map(n => n.split(' ')[0]!);
    let req: Req | undefined;
    (mod.refreshDashboard as any)(
      proc(h, env.client, r => {
        req = r;
        return anthropicResponse({
          classSummary: `${first[0]} (${ids[0]}) and ${first[1]} (id ${ids[1]}) add the bottoms; student ${ids[2]} is done.`,
          clusters: [
            { name: 'Adding bottoms', description: `${first[0]} (${ids[0]}) and ${first[1]} [#${ids[1]}] add the denominators.`, learnerIds: ids.slice(0, 2) },
            { name: 'On track', description: `${names[2]} (${ids[2]}) and ${first[3]} got 8/8 (= 1).`, learnerIds: ids.slice(2) },
          ],
        });
      }),
      { classSessionId: cls.id }
    );
    const body = JSON.parse(req!.text);
    const user = body.messages[0].content as string;
    expect(user).toContain(`Roster (learnerId: name), for learnerIds only: ${ids[0]}: ${names[0]}`);
    expect(user).not.toMatch(/Student \d+ —/);
    for (const n of names) expect(user).toContain(`=== ${n}, age`);
    expect(JSON.stringify(body.system)).toContain('Never write learner ids');
    expect(body.output_config.effort).toBe(C.DASHBOARD_EFFORT);
    expect(h.db.classSummary.classSessionId.find(cls.id)!.summary).toBe(`${first[0]} and ${first[1]} add the bottoms; ${first[2]} is done.`);
    const descs = [...h.db.studentCluster.classSessionId.filter(cls.id)].sort((a, b) => a.position - b.position).map(c => c.description);
    expect(descs).toEqual([`${first[0]} and ${first[1]} add the denominators.`, `${names[2]} and ${first[3]} got 8/8 (= 1).`]);
    expect(clustersOf(h, cls.id).map(c => c.ids)).toEqual([ids.slice(0, 2), ids.slice(2)]);
  });

  it('DASHBOARD_EFFORT env overrides the dashboard thinking effort', () => {
    const { h, env, cls } = classWithSims(2, setup({ ...ANTHROPIC, DASHBOARD_EFFORT: 'medium' }));
    let req: Req | undefined;
    (mod.refreshDashboard as any)(proc(h, env.client, r => ((req = r), anthropicResponse({ classSummary: 'ok', clusters: [] }))), { classSessionId: cls.id });
    expect(JSON.parse(req!.text).output_config.effort).toBe('medium');
  });

  it('repairs invalid LLM clusters (sizes, duplicates, unknown and missing students)', () => {
    const { h, cls, ids } = classWithSims(6);
    advance(h, C.DASHBOARD_INTERVAL_S);
    runDashboardJobs(h, dashboardAnswer('x', [
      { name: 'A', ids: [ids[0]!, ids[1]!, ids[2]!] },
      { name: 'B', ids: [ids[2]!, ids[3]!, '424242'] },
      { name: 'C', ids: [ids[4]!] },
    ]));
    const cl = clustersOf(h, cls.id);
    expect(clusterViolations(cl.map(c => ({ name: c.name, description: '', learnerIds: c.ids })), ids)).toEqual([]);
    expect(cl.flatMap(c => c.ids).sort()).toEqual([...ids].sort());
  });

  it('odd class: exactly one cluster of 3', () => {
    const { h, cls, ids } = classWithSims(7);
    advance(h, C.DASHBOARD_INTERVAL_S);
    runDashboardJobs(h, dashboardAnswer('x', [{ name: 'All', ids }]));
    const sizes = clustersOf(h, cls.id).map(c => c.ids.length).sort();
    expect(sizes.filter(s => s === 3)).toHaveLength(1);
    expect(sizes.every(s => s === 2 || s === 3 || s === 4)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('second refresh replaces clusters atomically and bumps the version', () => {
    const { h, env, cls, ids } = classWithSims(4);
    const refresh = (r: Responder) => (mod.refreshDashboard as any)(proc(h, env.client, r), { classSessionId: cls.id });
    refresh(dashboardAnswer('one', [{ name: 'A', ids: ids.slice(0, 2) }, { name: 'B', ids: ids.slice(2) }]));
    refresh(dashboardAnswer('two', [{ name: 'All four', ids }]));
    expect(clustersOf(h, cls.id)).toEqual([{ name: 'All four', ids }]);
    expect(h.db.classSummary.classSessionId.find(cls.id)).toMatchObject({ summary: 'two', version: 2 });
  });

  it('LLM failure keeps the old summary and retries in 10 s', () => {
    const { h, cls } = classWithSims(2);
    advance(h, C.DASHBOARD_INTERVAL_S);
    runDashboardJobs(h, () => ({ status: 500, body: 'oops' }));
    const st = h.db.dashboardState.classSessionId.find(cls.id)!;
    expect(st.running).toBe(false);
    expect(st.lastError).toMatch(/HTTP 500/);
    const [job] = [...h.db.dashboardJob.iter()];
    expect(at(job) - now(h)).toBe(BigInt(C.DASHBOARD_RETRY_S) * 1_000_000n);
  });

  it('impersonation pauses refreshes; stopping when overdue refreshes at once, else at the due time', () => {
    const { h, env, cls, ids } = classWithSims(2);
    const learnerId = BigInt(ids[0]!);
    call(h, env.client, mod.setImpersonation, { classSessionId: cls.id, learnerId });
    expect(h.db.dashboardState.classSessionId.find(cls.id)!.impersonatingLearnerId).toBe(learnerId);
    advance(h, C.DASHBOARD_INTERVAL_S + 5);
    expect(runDashboardJobs(h)).toBe(1); // no responder: no HTTP call while observing
    expect([...h.db.dashboardJob.iter()]).toHaveLength(0);
    expect(h.db.classSummary.classSessionId.find(cls.id)).toBeFalsy();
    const button = ((mod.refreshDashboard as any)(proc(h, env.client), { classSessionId: cls.id }));
    expect(button).toEqual({ ok: false, skipped: 'impersonating', error: '', repaired: false, repairs: [], clusters: 0 });
    expect(() => call(h, env.client, mod.setImpersonation, { classSessionId: cls.id, learnerId: 777n })).toThrow(/not in class session/);

    call(h, env.client, mod.setImpersonation, { classSessionId: cls.id, learnerId: 0n });
    const [job] = [...h.db.dashboardJob.iter()];
    expect(at(job)).toBe(now(h)); // overdue -> now
    runDashboardJobs(h, dashboardAnswer('after observing', [{ name: 'Pair', ids }]));
    expect(h.db.classSummary.classSessionId.find(cls.id)!.summary).toBe('after observing');

    // Not overdue: the job keeps its due time.
    call(h, env.client, mod.setImpersonation, { classSessionId: cls.id, learnerId });
    call(h, env.client, mod.setImpersonation, { classSessionId: cls.id, learnerId: 0n });
    const [later] = [...h.db.dashboardJob.iter()];
    expect(at(later)).toBe(h.db.dashboardState.classSessionId.find(cls.id)!.nextDueAt.microsSinceUnixEpoch);
    expect(at(later) > now(h)).toBe(true);
  });

  it('a scheduled run that is not due yet (refresh button moved it) does nothing', () => {
    const { h, env, cls, ids } = classWithSims(2);
    // Stale job left over at the old time, then the button refreshes.
    (mod.refreshDashboard as any)(proc(h, env.client, dashboardAnswer('btn', [{ name: 'P', ids }])), { classSessionId: cls.id });
    h.withReducerTx(TestAuth.internal(), ctx => ctx.db.dashboardJob.insert({ scheduledId: 0n, scheduledAt: { tag: 'Time', value: ctx.timestamp } as never, classSessionId: cls.id }));
    const before = [...h.db.dashboardJob.iter()].length;
    runDashboardJobs(h); // no responder: would throw on HTTP
    expect(before).toBe(2);
    expect(h.db.classSummary.classSessionId.find(cls.id)!.version).toBe(1);
  });

  it('watchdog: a run that dies without finishing is taken over by the backup job after the stale limit', () => {
    const { h, env, cls, ids } = classWithSims(2);
    // While a run is in flight, a backup job sits just past the stale limit.
    let backupAt = 0n;
    (mod.refreshDashboard as any)(
      proc(h, env.client, (r, hh) => {
        backupAt = [...hh.db.dashboardJob.classSessionId.filter(cls.id)].map(at).reduce((a, b) => (a > b ? a : b), 0n);
        return dashboardAnswer('first', [{ name: 'P', ids }])(r, hh);
      }),
      { classSessionId: cls.id }
    );
    expect(backupAt - now(h)).toBeGreaterThanOrEqual(120_000_000n);
    // Simulate a fatal crash mid-run: running stays set, only the backup job is queued.
    h.withReducerTx(TestAuth.internal(), ctx => {
      const st = ctx.db.dashboardState.classSessionId.find(cls.id)!;
      ctx.db.dashboardState.classSessionId.update({ ...st, running: true, runStartedAt: ctx.timestamp });
      for (const j of [...ctx.db.dashboardJob.classSessionId.filter(cls.id)]) ctx.db.dashboardJob.scheduledId.delete(j.scheduledId);
      ctx.db.dashboardJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + 121_000_000n), classSessionId: cls.id });
    });
    advance(h, 125);
    expect(runDashboardJobs(h, dashboardAnswer('recovered', [{ name: 'P', ids }]))).toBeGreaterThan(0);
    expect(h.db.classSummary.classSessionId.find(cls.id)!.summary).toBe('recovered');
    expect(h.db.dashboardState.classSessionId.find(cls.id)!.running).toBe(false);
  });

  it('no students: summary without an LLM call, clusters cleared', () => {
    const env = setup(ANTHROPIC);
    const cls = startClass(env, teacher(env).id);
    const out = ((mod.refreshDashboard as any)(proc(env.h, env.client), { classSessionId: cls.id }));
    expect(out.ok).toBe(true);
    expect(env.h.db.classSummary.classSessionId.find(cls.id)!.summary).toMatch(/No students/);
  });
});

// ---------------------------------------------------------------- extraction dedupe

describe('memory extraction window dedupe (running marker)', () => {
  it('a turn appended during the LLM call does not schedule a duplicate window; the follow-up comes after', () => {
    const env = setup({ ...ANTHROPIC, MEMORY_EVERY_N_TURNS: '2' });
    const { h, client } = env;
    const l = makeLearner(h, client, 'Dee');
    const s = makeSession(h, client, l.id);
    call(h, client, mod.setSessionVoice, { sessionId: s.id, voice: false });
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'one', intent: '' });
    tutorReplies(env, s.id, 'Two.');
    expect([...h.db.extractionJob.iter()]).toHaveLength(1);
    const windows: string[] = [];
    let duringCall = -1;
    runExtraction(h, (r, hh) => {
      windows.push(JSON.parse(r.text).messages[0].content);
      // While the window is in flight two more turns arrive.
      call(hh, client, mod.submitTextTurn, { sessionId: s.id, text: 'three', intent: '' });
      tutorReplies(env, s.id, 'Four.');
      // Only the watchdog backup of the running window is queued (due after the stale limit).
      duringCall = [...hh.db.extractionJob.iter()].filter(j => !(j.fromIdx === 0 && at(j) >= now(hh) + 300_000_000n)).length;
      return anthropicResponse({ items: [], mastery: [] });
    });
    expect(duringCall).toBe(0); // the old code scheduled [0, 4) again here
    const jobs = [...h.db.extractionJob.iter()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ fromIdx: 2, toIdx: 4 });
    expect(h.db.extractionCursor.sessionId.find(s.id)).toMatchObject({ nextIdx: 2, runningSinceMicros: 0n });
    runExtraction(h, r => (windows.push(JSON.parse(r.text).messages[0].content), anthropicResponse({ items: [], mastery: [] })));
    expect(windows).toHaveLength(2);
    expect(windows[1]).toContain('turns 2..3');
  });

  it('a duplicate job for a window in flight is dropped without an LLM call', () => {
    const env = setup({ ...ANTHROPIC, MEMORY_EVERY_N_TURNS: '2' });
    const { h, client } = env;
    const l = makeLearner(h, client, 'Eve');
    const s = makeSession(h, client, l.id);
    h.withReducerTx(TestAuth.internal(), ctx => {
      const c = ctx.db.extractionCursor.sessionId.find(s.id)!;
      ctx.db.extractionCursor.sessionId.update({ ...c, runningSinceMicros: ctx.timestamp.microsSinceUnixEpoch });
      ctx.db.extractionJob.insert({ scheduledId: 0n, scheduledAt: { tag: 'Time', value: ctx.timestamp } as never, sessionId: s.id, learnerId: l.id, fromIdx: 0, toIdx: 2, attempt: 0 });
    });
    expect(runExtraction(h)).toBe(1); // no responder: an HTTP call would throw
  });
});

// ---------------------------------------------------------------- simulated students: optional reset

describe('simulated students reset option', () => {
  const simByRank = (h: H, rank: number) => simLearners(h).filter(l => l.simRank === rank);

  function startWith(env: Env, teacherId: bigint, simulatedCount: number, resetSimulated: boolean) {
    call(env.h, env.client, mod.startClassSessionWith, {
      teacherId, goals: 'g', content: 'Adding fractions', delivery: '', documentName: '', documentMime: '', documentText: '',
      documentData: new Uint8Array(), simulatedCount, resetSimulated,
    });
    return [...env.h.db.classSession.iter()].filter(c => c.teacherId === teacherId && c.active)[0]!;
  }

  it('resetSimulated = false keeps memory, history and learner ids; true (and the old reducer) resets', () => {
    const env = setup();
    const { h } = env;
    const t = teacher(env);
    const c1 = startWith(env, t.id, 2, true);
    const first = simLearners(h);
    expect(first.map(l => l.simRank)).toEqual([1, 2]);
    const s1 = linked(h, c1.id).find(s => s.learnerId === first[0]!.id)!;
    call(h, env.agent, mod.remember, { sessionId: s1.id, kind: 'quote', category: 'fractions', concept: '', text: 'learned in run 1', outcome: 'worked' });
    call(h, env.client, mod.endClassSession, { classSessionId: c1.id });

    const c2 = startWith(env, t.id, 3, false);
    const second = simLearners(h);
    expect(second.map(l => l.simRank)).toEqual([1, 2, 3]);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[1]!.id).toBe(first[1]!.id);
    expect([...h.db.memoryNote.learnerId.filter(first[0]!.id)].map(n => n.text)).toContain('learned in run 1');
    expect(h.db.session.id.find(s1.id)).toBeTruthy(); // the earlier session stays as history
    const l2 = linked(h, c2.id);
    expect(l2).toHaveLength(3);
    expect(l2.every(s => !s.voice)).toBe(true);

    call(h, env.client, mod.endClassSession, { classSessionId: c2.id });
    startClass(env, t.id, { simulatedCount: 2 }); // old reducer: always resets
    const rank1 = simByRank(h, 1)[0]!;
    expect(rank1.id).not.toBe(first[0]!.id);
    expect([...h.db.memoryNote.learnerId.filter(rank1.id)].map(n => n.text)).toEqual(SIM_STUDENTS[0]!.memory.map(n => n.text));
    expect(h.db.session.id.find(s1.id) ?? undefined).toBeUndefined();
  });

  it('resetSimulatedStudents(count) resets 1..count in seed order (0 = all), refused while in a running class', () => {
    const env = setup();
    const { h } = env;
    expect(() => call(h, env.client, mod.resetSimulatedStudents, { count: 3 })).toThrow(/teachers only/);
    teacher(env, 'Mr. Reset');
    call(h, env.client, mod.resetSimulatedStudents, { count: 3 });
    expect(simLearners(h).map(l => [l.simRank, l.name])).toEqual(SIM_STUDENTS.slice(0, 3).map(s => [s.rank, s.name]));
    const t = teacher(env);
    const c = startWith(env, t.id, 2, false);
    expect(simByRank(h, 1)).toHaveLength(1);
    expect(() => call(h, env.client, mod.resetSimulatedStudents, { count: 0 })).toThrow(/running class session/);
    call(h, env.client, mod.endClassSession, { classSessionId: c.id });
    const before = simByRank(h, 1)[0]!.id;
    call(h, env.client, mod.resetSimulatedStudents, { count: 0 });
    expect(simLearners(h)).toHaveLength(SIM_STUDENTS.length);
    expect(simByRank(h, 1)[0]!.id).not.toBe(before);
    for (const rank of [1, 2]) {
      const l = simByRank(h, rank)[0]!;
      expect([...h.db.session.learnerId.filter(l.id)]).toHaveLength(0);
      expect([...h.db.memoryNote.learnerId.filter(l.id)].map(n => n.text)).toEqual(SIM_STUDENTS[rank - 1]!.memory.map(n => n.text));
      // seeded past only: the persona's mastery and earlier sessions, nothing from the class run
      expect([...h.db.conceptState.learnerId.filter(l.id)].map(c => [c.concept, c.mastery])).toEqual(SIM_STUDENTS[rank - 1]!.mastery.map(m => [m.concept, m.mastery]));
      expect([...h.db.sessionSummary.learnerId.filter(l.id)]).toHaveLength(SIM_STUDENTS[rank - 1]!.history.length);
    }
    expect(() => call(h, env.client, mod.resetSimulatedStudents, { count: 21 })).toThrow(/at most 20/);
  });
});
