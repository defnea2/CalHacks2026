// The two-minute demo arc in the module (LESSON_ARC default demo2min): policy at beginLesson,
// formalization slot + per-sentence keyframe, moment cap, worst-case path explain -> repair ->
// hand back; topic prefetch + library material; utterance-scoped interrupt in the last sentence.
import { describe, it, expect } from 'vitest';
import { demoHandBackMeta, demoHandBackMoments, demoMeta, demoMoments, demoRepairMeta, demoRepairMoments } from '../../teaching/test/fixtures';
import { call, makeLearner, makeSession, mod, proc, runTextPlay, runTts, session, setup, studentSays, turns, ttsSse, type Req } from './helpers';

const TASK = 'Expand 2/3 so the bottom number is 12.';
type Env = ReturnType<typeof setup> & { s: ReturnType<typeof makeSession> };
type M = { visual: Record<string, unknown>; narration: string; [k: string]: unknown };

function demo(opts: { voice?: boolean; env?: Record<string, string> } = {}): Env {
  const env = setup(opts.env ?? {});
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id, TASK);
  if (!opts.voice) call(env.h, env.client, mod.setSessionVoice, { sessionId: s.id, voice: false });
  return { ...env, s };
}
const say = (e: Env, text: string) => call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text, intent: '' });
const request = (e: Env) => JSON.parse((mod.buildLessonRequest as any)(proc(e.h, e.agent), { sessionId: e.s.id, requestId: 'r' }));
const beats = (e: Env, u: bigint) => [...e.h.db.beat.sessionId.filter(e.s.id)].filter(b => b.utteranceId === u).sort((a, b) => a.idx - b.idx);
const lesson = (e: Env) => e.h.db.lessonState.sessionId.find(e.s.id)!;
const scene = (e: Env) => JSON.parse(e.h.db.canvasState.sessionId.find(e.s.id)!.scene);

function addBeat(e: Env, u: bigint, i: number, m: M, final: boolean) {
  const { narration, ...rest } = m;
  call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: u, idx: i, visual: JSON.stringify(final ? { ...rest, final: true } : rest), narration });
}
/** One whole step for the latest student turn, read to the end (text mode). */
function step(e: Env, u: bigint, meta: object, moments: M[]) {
  call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: u, replyToIdx: turns(e.h, e.s.id).filter(t => t.role === 'student').at(-1)!.idx, preemptive: false });
  call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: u, meta: JSON.stringify(meta) });
  moments.forEach((m, i) => addBeat(e, u, i, m, i === moments.length - 1));
  call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: u, text: 'lesson', interrupted: false });
  runTextPlay(e.h);
}

describe('demo2min arc', () => {
  it('first request: the arc travels in the session config, topic prefetched, library material attached', () => {
    const e = demo();
    say(e, 'I do not get it.');
    const out = request(e);
    expect(out.request.context.allowedPhases).toEqual(['intuition']);
    expect(out.request.context.session.arc.id).toBe('demo2min');
    expect(out.topic).toEqual({ category: 'fractions', concept: 'fractions-expand' });
    expect(out.library.concept).toBe('fractions-expand');
    expect(out.library.skills.length).toBeGreaterThan(0);
    expect(session(e.h, e.s.id)).toMatchObject({ category: 'fractions', concept: 'fractions-expand' });
  });

  it('LESSON_ARC=adaptive keeps the previous policy (no arc in the config)', () => {
    const e = demo({ env: { LESSON_ARC: 'adaptive' } });
    say(e, 'Help');
    expect(request(e).request.context.session.arc).toBeUndefined();
  });

  it('explain step: moment 3 is the formalization (equation forced on, revealed with its second sentence); the task follows', () => {
    const e = demo();
    say(e, 'I do not get it.');
    call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: 100n, replyToIdx: 0, preemptive: false });
    // Diagnosis first is not allowed: the tutor owns the explanation.
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 100n, meta: JSON.stringify({ ...demoMeta, phase: 'diagnose' }) })).toThrow(/Allowed: intuition/);
    // The task may not be the homework itself (it is handed back at the end).
    const homework = { ...demoMeta, check: { kind: 'number', prompt: `${TASK} What is the new top number?`, rule: { operation: 'value', value: 8 } } };
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 100n, meta: JSON.stringify(homework) })).toThrow(/own homework/);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 100n, meta: JSON.stringify(demoMeta) });
    demoMoments.slice(0, 3).forEach((m, i) => addBeat(e, 100n, i, m, false));
    const formal = JSON.parse(beats(e, 100n)[2]!.visual);
    expect(formal.cues).toHaveLength(2);
    expect(formal.cues[1].id).toMatch(/-s1$/);
    expect(formal.cues[1].commands).toEqual([{ type: 'update_math', id: 'math', change: { type: 'set_equation', visible: true } }]);
    expect(scene(e).math.visual.showEquation).toBe(true);
    addBeat(e, 100n, 3, demoMoments[3]!, false);
    expect(scene(e).math.visual.showEquation).toBe(false); // the task does not show the answer
    // Moment cap: moment 5 must be the final one.
    expect(() => addBeat(e, 100n, 4, demoMoments[4]!, false)).toThrow(/at most 5 moments/);
    addBeat(e, 100n, 4, demoMoments[4]!, true);
    expect(JSON.parse(lesson(e).notes)).toMatchObject({ phase: 'intuition', beatCount: 5, check: { kind: 'choice' } });
  });

  it('worst case: "I don\'t know" -> one repair with a smaller task -> hand back, whatever the answer', () => {
    const e = demo();
    say(e, 'Hmm.');
    step(e, 100n, demoMeta, demoMoments);
    expect(lesson(e)).toMatchObject({ stage: 'awaiting_response', checkPrompt: demoMeta.check.prompt });
    say(e, "I don't know");
    expect(JSON.parse(lesson(e).evidence).at(-1)).toMatchObject({ outcome: 'unclear' });
    expect(request(e).request.context.allowedPhases).toEqual(['repair']);
    step(e, 200n, demoRepairMeta, demoRepairMoments);
    say(e, 'five');
    expect(JSON.parse(lesson(e).evidence).at(-1)).toMatchObject({ outcome: 'incorrect' });
    expect(request(e).request.context.allowedPhases).toEqual(['return_to_problem']);
    step(e, 300n, demoHandBackMeta, demoHandBackMoments);
    expect(lesson(e).stage).toBe('completed');
  });

  it('a correct task answer hands back at once', () => {
    const e = demo();
    say(e, 'Hmm.');
    step(e, 100n, demoMeta, demoMoments);
    say(e, 'two quarters, 2/4');
    expect(JSON.parse(lesson(e).evidence).at(-1)).toMatchObject({ outcome: 'correct' });
    expect(request(e).request.context.allowedPhases).toEqual(['return_to_problem']);
  });
});

describe('prefetchTopic', () => {
  it('keyword cues set the concept once; unknown text is left to the worker classifier', () => {
    const e = demo();
    const out = JSON.parse((mod.prefetchTopic as any)(proc(e.h, e.agent), { sessionId: e.s.id }));
    expect(out).toMatchObject({ ok: true, category: 'fractions', concept: 'fractions-expand', source: 'keywords' });
    const again = JSON.parse((mod.prefetchTopic as any)(proc(e.h, e.agent), { sessionId: e.s.id }));
    expect(again.source).toBe('session');
    const e2 = setup();
    const l = makeLearner(e2.h, e2.client);
    const s2 = makeSession(e2.h, e2.client, l.id, 'Page 34, number 5');
    const none = JSON.parse((mod.prefetchTopic as any)(proc(e2.h, e2.agent), { sessionId: s2.id }));
    expect(none).toMatchObject({ ok: false, concept: '', source: 'none', text: 'Page 34, number 5' });
    expect(() => (mod.prefetchTopic as any)(proc(e2.h, e2.client), { sessionId: s2.id })).toThrow(/agent only/);
  });
});

describe('interruptUtterance', () => {
  const ttsOk = (req: Req) => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(req.text.length % 7)) });
  it('barge-in during the LAST sentence marks the finished tutor turn interrupted (interrupt alone did not)', () => {
    const e = demo({ voice: true });
    studentSays(e.h, e.client, e.s.id, 'Help me');
    call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: 100n, replyToIdx: 0, preemptive: false });
    call(e.h, e.agent, mod.addSentence, { sessionId: e.s.id, utteranceId: 100n, idx: 0, display: 'One.', speech: 'One.' });
    call(e.h, e.agent, mod.addSentence, { sessionId: e.s.id, utteranceId: 100n, idx: 1, display: 'Two.', speech: 'Two.' });
    runTts(e.h, ttsOk);
    call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: 100n, text: 'One. Two.', interrupted: false });
    call(e.h, e.client, mod.markPlayed, { sessionId: e.s.id, utteranceId: 100n, idx: 0 });
    call(e.h, e.client, mod.markPlayed, { sessionId: e.s.id, utteranceId: 100n, idx: 1 }); // last sentence STARTS
    expect(session(e.h, e.s.id)).toMatchObject({ currentUtteranceId: 0n, turnState: 'listening' });
    call(e.h, e.client, mod.interrupt, { sessionId: e.s.id });
    const tutor = () => turns(e.h, e.s.id).find(t => t.role === 'tutor')!;
    expect(tutor().interrupted).toBe(false); // the old gap
    call(e.h, e.client, mod.interruptUtterance, { sessionId: e.s.id, utteranceId: 100n });
    expect(tutor().interrupted).toBe(true);
    expect(tutor().text).toBe('One. Two.');
    // Idempotent, and an unknown utterance is ignored.
    call(e.h, e.client, mod.interruptUtterance, { sessionId: e.s.id, utteranceId: 100n });
    call(e.h, e.client, mod.interruptUtterance, { sessionId: e.s.id, utteranceId: 999n });
  });

  it('on the current utterance it is a normal interrupt', () => {
    const e = demo({ voice: true });
    studentSays(e.h, e.client, e.s.id, 'Help me');
    call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: 100n, replyToIdx: 0, preemptive: false });
    call(e.h, e.agent, mod.addSentence, { sessionId: e.s.id, utteranceId: 100n, idx: 0, display: 'One.', speech: 'One.' });
    call(e.h, e.client, mod.interruptUtterance, { sessionId: e.s.id, utteranceId: 100n });
    expect(session(e.h, e.s.id)).toMatchObject({ currentUtteranceId: 0n, turnState: 'interrupted' });
  });
});
