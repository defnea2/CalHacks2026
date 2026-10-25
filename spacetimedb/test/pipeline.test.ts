// Team lesson planner in the module: beginLesson / addBeat / lesson_state / submitInteraction /
// agent_status / tutor requests. Fixture: the team's equivalent-fractions mini lesson.
import { describe, it, expect } from 'vitest';
import { miniMeta, miniMoments } from '../../teaching/test/fixtures';
import { auth, call, makeLearner, makeSession, mod, proc, runTextPlay, runTts, session, setup, studentSays, turns, type Req } from './helpers';
import { ttsSse } from './helpers';

type Env = ReturnType<typeof setup> & { s: ReturnType<typeof makeSession> };
const U = 100n;
const ttsOk = (req: Req) => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(req.text.length % 7)) });

function lessonSession(voice = false, say = 'Why is 2/4 the same as 1/2?'): Env {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id, 'Equivalent fractions');
  if (!voice) call(env.h, env.client, mod.setSessionVoice, { sessionId: s.id, voice: false });
  if (voice) studentSays(env.h, env.client, s.id, say);
  else call(env.h, env.client, mod.submitTextTurn, { sessionId: s.id, text: say, intent: '' });
  return { ...env, s };
}
const begin = (e: Env, u = U, idx = turns(e.h, e.s.id).filter(t => t.role === 'student').at(-1)!.idx) =>
  call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: u, replyToIdx: idx, preemptive: false });
const momentArgs = (i: number, final = false) => {
  const { narration, ...rest } = miniMoments[i]!;
  return { visual: JSON.stringify(final ? { ...rest, final: true } : rest), narration };
};
const addBeat = (e: Env, i: number, final = false, u = U) => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: u, idx: i, ...momentArgs(i, final) });
const lesson = (e: Env) => e.h.db.lessonState.sessionId.find(e.s.id)!;
const canvas = (e: Env) => e.h.db.canvasState.sessionId.find(e.s.id)!;
const beats = (e: Env) => [...e.h.db.beat.sessionId.filter(e.s.id)].sort((a, b) => a.idx - b.idx);
const sentences = (e: Env, u = U) => [...e.h.db.replySentence.iter()].filter(x => x.utteranceId === u).sort((a, b) => a.idx - b.idx);

/** The whole mini lesson streamed into the module. */
function streamLesson(e: Env, u = U) {
  call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: u, meta: JSON.stringify(miniMeta) });
  for (let i = 0; i < miniMoments.length; i++) addBeat(e, i, i === miniMoments.length - 1, u);
}

describe('buildLessonRequest', () => {
  it('returns the team planner request for the current state (agent only)', () => {
    const e = lessonSession();
    const out = JSON.parse((mod.buildLessonRequest as any)(proc(e.h, e.agent), { sessionId: e.s.id, requestId: 'r1' }));
    expect(out.ok).toBe(true);
    expect(out.request).toMatchObject({ version: 1, requestId: 'r1', context: { allowedPhases: ['intuition'], currentStep: null, session: { lessonStyle: 'mini_lesson', topic: 'Equivalent fractions', age: 9 } } });
    // Learner profile + the typed question as context.
    expect(out.request.context.session.context.map((c: any) => c.source)).toEqual(['tutor memory', 'learner speech']);
    expect(out.request.context.session.context[1].text).toBe('Why is 2/4 the same as 1/2?');
    expect(() => (mod.buildLessonRequest as any)(proc(e.h, e.client), { sessionId: e.s.id, requestId: 'r1' })).toThrow(/agent only/);
  });
});

describe('beginLesson + addBeat', () => {
  it('valid beats: compiled against canvas_state, beat + sentences, canvas advances; final validates and the step is accepted', () => {
    const e = lessonSession();
    begin(e);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    expect(lesson(e).stage).toBe('presenting');
    addBeat(e, 0);
    const b0 = beats(e)[0]!;
    expect(b0).toMatchObject({ idx: 0, utteranceId: U, sentenceIdx: 0, canvasVersion: 1, narration: miniMoments[0]!.narration });
    const visual = JSON.parse(b0.visual);
    expect(visual.id).toBe('math-beat-0');
    expect(visual.cues[0].commands[0]).toMatchObject({ type: 'show_math', visual: { kind: 'bars', id: 'math', title: 'Equal shares' } });
    expect(JSON.parse(canvas(e).scene).math.visual.bars[0]).toMatchObject({ parts: 2, shaded: 1 });
    // Narration split into grammatical sentences (2), revealed at the first.
    expect(sentences(e).map(s => s.display)).toEqual(['Start with one whole split into two equal pieces.', 'One of these pieces is shaded, so one half is shaded.']);
    for (let i = 1; i < miniMoments.length; i++) addBeat(e, i, i === miniMoments.length - 1);
    expect(beats(e).map(b => b.sentenceIdx)).toEqual([0, 2, 5, 7, 10, 12]);
    expect(beats(e).at(-1)!.narration).toContain(miniMeta.check.prompt);
    expect(sentences(e).at(-1)!.display).toBe(miniMeta.check.prompt);
    expect(canvas(e).version).toBe(6);
    expect(JSON.parse(canvas(e).scene).math.visual.interactive).toBe(true);
    // Accepted, still presenting until the utterance finished.
    expect(lesson(e)).toMatchObject({ stage: 'presenting', checkPrompt: miniMeta.check.prompt, awaitingResponse: false });
    expect(JSON.parse(lesson(e).notes)).toMatchObject({ stepId: `step-${U}`, phase: 'intuition', beatCount: 6, check: { kind: 'explanation', prompt: miniMeta.check.prompt } });
    expect(JSON.parse(lesson(e).notes).check.rubric).toBeUndefined(); // never the answer key
    expect(() => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 6, ...momentArgs(5) })).toThrow(/already complete/);
  });

  it('invalid beats are rejected with the validator message and change nothing', () => {
    const e = lessonSession();
    begin(e);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    // update before any picture
    expect(() => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 0, visual: JSON.stringify({ kind: 'keep' }), narration: 'Look.' })).toThrow(/Show a math representation before/);
    // schema violation (parts > 12)
    expect(() => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 0, visual: JSON.stringify({ kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 40, shaded: 1 }] }), narration: 'Look.' })).toThrow(/parts/);
    expect(() => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 0, visual: '{nope', narration: 'Look.' })).toThrow(/not valid JSON/);
    expect(() => call(e.h, e.agent, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 3, ...momentArgs(0) })).toThrow(/expected beat 0/);
    expect(beats(e)).toHaveLength(0);
    expect(canvas(e).version).toBe(0);
    expect(sentences(e)).toHaveLength(0);
    // A final moment that makes the lesson too short is rejected; the earlier beats stay.
    addBeat(e, 0);
    expect(() => addBeat(e, 1, true)).toThrow(/at least 4 connected beats/);
    expect(beats(e)).toHaveLength(1);
  });

  it('meta is validated (schema + phase policy) before anything is spoken; agent only; stale utterances rejected', () => {
    const e = lessonSession();
    begin(e);
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify({ ...miniMeta, phase: 'solo' }) })).toThrow(/Phase is not supported.*Allowed: intuition/);
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify({ phase: 'intuition' }) })).toThrow(/invalid lesson meta/);
    expect(() => call(e.h, e.client, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) })).toThrow(/agent only/);
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 999n, meta: JSON.stringify(miniMeta) })).toThrow(/not current/);
    expect(() => addBeat(e, 0)).toThrow(/beginLesson first/);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    // Repair round: re-planning before anything was spoken replaces the plan; after a beat it is refused.
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    addBeat(e, 0);
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) })).toThrow(/already has a lesson/);
    expect(() => call(e.h, e.client, mod.addBeat, { sessionId: e.s.id, utteranceId: U, idx: 0, ...momentArgs(0) })).toThrow(/agent only/);
  });

  it('version conflict: a canvas change during the lesson rejects the next beat', () => {
    const e = lessonSession();
    begin(e);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    addBeat(e, 0);
    // Simulate a foreign canvas write.
    e.h.withReducerTx(auth('internal-test') as never, ctx => {
      const row = ctx.db.canvasState.sessionId.find(e.s.id)!;
      ctx.db.canvasState.sessionId.update({ ...row, version: row.version + 1 });
    });
    expect(() => addBeat(e, 1)).toThrow(/canvas changed during the lesson \(version 2, expected 1\)/);
  });
});

describe('lesson_state over the utterance (text mode)', () => {
  it('presented after the last sentence was read -> awaiting_response; an answer records evidence', () => {
    const e = lessonSession();
    begin(e);
    streamLesson(e);
    call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: U, text: 'lesson', interrupted: false });
    expect(lesson(e).stage).toBe('presenting');
    runTextPlay(e.h);
    expect(session(e.h, e.s.id).turnState).toBe('listening');
    expect(lesson(e)).toMatchObject({ stage: 'awaiting_response', awaitingResponse: true, checkPrompt: miniMeta.check.prompt });
    call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text: 'the pieces get smaller but the same amount is shaded', intent: '' });
    const ev = JSON.parse(lesson(e).evidence);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ stepId: `step-${U}`, outcome: 'unclear', source: 'unassessed', response: { kind: 'answer' } });
    expect(lesson(e).stage).toBe('needs_plan');
    // The next request lets the model assess the explanation.
    const out = JSON.parse((mod.buildLessonRequest as any)(proc(e.h, e.agent), { sessionId: e.s.id, requestId: 'r2' }));
    expect(out.request.context.phaseOptionsAfterAssessment).toBeTruthy();
    // The next step may not re-ask the same check.
    call(e.h, e.agent, mod.beginUtterance, { sessionId: e.s.id, utteranceId: 200n, replyToIdx: turns(e.h, e.s.id).at(-1)!.idx, preemptive: false });
    const again = { ...miniMeta, assessment: { evidenceId: ev[0].eventId, judgement: 'unclear', observation: 'Vague.' } };
    expect(() => call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 200n, meta: JSON.stringify(again) })).toThrow(/repeats a question/);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: 200n, meta: JSON.stringify({ ...again, check: { ...miniMeta.check, prompt: 'What stays the same when we cut more pieces?' } }) });
  });

  it('a typed turn mid-lesson interrupts: needs_plan, canvas rolls back to the last beat the learner saw', () => {
    const e = lessonSession();
    begin(e);
    call(e.h, e.agent, mod.beginLesson, { sessionId: e.s.id, utteranceId: U, meta: JSON.stringify(miniMeta) });
    addBeat(e, 0);
    addBeat(e, 1);
    addBeat(e, 2);
    // Beat 0 (two sentences) read, beat 1's first sentence on screen; beat 2 never shown.
    const jobs = [...e.h.db.textPlayJob.iter()].map(j => ({ idx: j.idx, at: (j.scheduledAt as any).value.microsSinceUnixEpoch ?? (j.scheduledAt as any).value }));
    runTextPlay(e.h, jobs.find(j => j.idx === 1)!.at);
    expect(sentences(e).slice(0, 3).map(s => s.status)).toEqual(['played', 'played', 'ready']);
    call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text: '', intent: 'smaller_step' });
    expect(lesson(e).stage).toBe('needs_plan');
    const scene = JSON.parse(canvas(e).scene);
    expect(scene.math.visual.bars[0]).toMatchObject({ parts: 4, shaded: 2 }); // after beat 1, not beat 2 (6/3)
    expect(canvas(e).version).toBe(4);
    expect(e.h.db.lessonPlan.utteranceId.find(U)).toBeFalsy();
    // No step was accepted, so the help request is unscored context.
    expect(JSON.parse(lesson(e).evidence)).toHaveLength(0);
  });

  it('help intents after a lesson become help evidence; continue records nothing', () => {
    const e = lessonSession();
    begin(e);
    streamLesson(e);
    call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: U, text: 'lesson', interrupted: false });
    runTextPlay(e.h);
    call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text: '', intent: 'another_way' });
    expect(JSON.parse(lesson(e).evidence)[0]).toMatchObject({ outcome: 'not_assessed', response: { kind: 'help', request: 'another_way' } });
    const out = JSON.parse((mod.buildLessonRequest as any)(proc(e.h, e.agent), { sessionId: e.s.id, requestId: 'r3' }));
    expect(out.request.context.allowedPhases).toEqual(['intuition', 'repair']);
    call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text: '', intent: 'continue' });
    expect(JSON.parse(lesson(e).evidence)).toHaveLength(1);
  });
});

describe('lesson_state in voice mode', () => {
  it('beats queue TTS; presented when the last sentence started playing; barge-in before the end interrupts', () => {
    const e = lessonSession(true);
    begin(e);
    streamLesson(e);
    expect([...e.h.db.ttsJob.iter()].length).toBe(sentences(e).length);
    runTts(e.h, ttsOk);
    call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: U, text: 'lesson', interrupted: false });
    for (const s of sentences(e)) call(e.h, e.client, mod.markPlayed, { sessionId: e.s.id, utteranceId: U, idx: s.idx });
    expect(lesson(e).stage).toBe('awaiting_response');

    const e2 = lessonSession(true);
    begin(e2);
    streamLesson(e2);
    runTts(e2.h, ttsOk);
    call(e2.h, e2.client, mod.markPlayed, { sessionId: e2.s.id, utteranceId: U, idx: 0 });
    call(e2.h, e2.client, mod.interrupt, { sessionId: e2.s.id });
    expect(lesson(e2).stage).toBe('needs_plan');
    expect(JSON.parse(canvas(e2).scene).math.visual.bars[0]).toMatchObject({ parts: 2, shaded: 1 });
  });
});

describe('submitInteraction', () => {
  function awaiting(): Env {
    const e = lessonSession();
    begin(e);
    streamLesson(e);
    call(e.h, e.agent, mod.appendTutorTurn, { sessionId: e.s.id, utteranceId: U, text: 'lesson', interrupted: false });
    runTextPlay(e.h);
    return e;
  }
  const events = (e: Env) => [...e.h.db.learnerEvent.sessionId.filter(e.s.id)].sort((a, b) => (a.id < b.id ? -1 : 1));

  it('rejected while the picture is not open for answers (recorded, not applied)', () => {
    const e = lessonSession();
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'submit', payload: '{}' });
    expect(events(e)[0]).toMatchObject({ kind: 'submit', accepted: false });
    expect(JSON.parse(events(e)[0]!.evidence).error).toMatch(/not open/);
    expect(() => call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'dance', payload: '{}' })).toThrow(/unknown interaction/);
    expect(() => call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'submit', payload: '{x' })).toThrow(/not valid JSON/);
  });

  it('math_action: validated against canvas_state (revision, allowed changes) and applied as an observation', () => {
    const e = awaiting();
    const c = canvas(e);
    const rev = JSON.parse(c.scene).math.revision;
    const action = (eventId: string, change: object, revision = rev) => JSON.stringify({ eventId, visualId: 'math', revision, change });
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'math_action', payload: action('m1', { type: 'set_bar', barId: 'whole', parts: 6, shaded: 3 }) });
    expect(events(e)[0]).toMatchObject({ accepted: true });
    expect(canvas(e).version).toBe(c.version + 1);
    expect(JSON.parse(canvas(e).scene).math.visual.bars[0]).toMatchObject({ parts: 6, shaded: 3 });
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'math_action', payload: action('m2', { type: 'set_bar', barId: 'whole', parts: 8, shaded: 4 }, rev) });
    expect(events(e)[1]).toMatchObject({ accepted: false });
    expect(JSON.parse(events(e)[1]!.evidence).error).toMatch(/Stale picture revision/);
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'math_action', payload: action('m3', { type: 'set_equation', visible: true }, rev + 1) });
    expect(JSON.parse(events(e)[2]!.evidence).error).toMatch(/cannot set_equation/);
    expect(JSON.parse(lesson(e).evidence)).toHaveLength(0); // observations are not mastery
  });

  it('submit: evidence recorded against the current canvas and the next step is requested (a student turn)', () => {
    const e = awaiting();
    const before = turns(e.h, e.s.id).length;
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'submit', payload: '{}' });
    const ev = events(e)[0]!;
    expect(ev.accepted).toBe(true);
    expect(JSON.parse(ev.evidence)).toMatchObject({ response: { kind: 'interaction' }, stepId: `step-${U}` });
    expect(JSON.parse(lesson(e).evidence)).toHaveLength(1);
    const t = turns(e.h, e.s.id).at(-1)!;
    expect(turns(e.h, e.s.id).length).toBe(before + 1);
    expect(t).toMatchObject({ role: 'student', status: 'ready', text: 'Here is my picture.' });
    expect(JSON.parse(lesson(e).evidence)).toHaveLength(1); // the turn did not record a second answer
  });

  it('choice requires a choice check', () => {
    const e = awaiting();
    call(e.h, e.client, mod.submitInteraction, { sessionId: e.s.id, kind: 'choice', payload: JSON.stringify({ optionId: 'a' }) });
    expect(events(e)[0]).toMatchObject({ accepted: false });
  });
});

describe('agent_status and tutor requests', () => {
  it('heartbeat upserts row 0 (agent only)', () => {
    const e = lessonSession();
    call(e.h, e.agent, mod.agentHeartbeat, { model: 'claude-haiku-5-5', provider: 'anthropic', busySessions: 2 });
    call(e.h, e.agent, mod.agentHeartbeat, { model: 'claude-haiku-5-5', provider: 'anthropic', busySessions: 0 });
    expect([...e.h.db.agentStatus.iter()]).toEqual([expect.objectContaining({ id: 0, busySessions: 0, model: 'claude-haiku-5-5' })]);
    expect(() => call(e.h, e.client, mod.agentHeartbeat, { model: 'x', provider: 'y', busySessions: 0 })).toThrow(/agent only/);
  });

  it('request -> result', () => {
    const e = lessonSession();
    call(e.h, e.client, mod.requestTutor, { sessionId: e.s.id, kind: 'shear_feedback', payload: JSON.stringify({ shear: 2 }) });
    const req = [...e.h.db.tutorRequest.iter()][0]!;
    expect(req.status).toBe('pending');
    expect(() => call(e.h, e.client, mod.requestTutor, { sessionId: e.s.id, kind: 'other', payload: '{}' })).toThrow(/unknown tutor request/);
    expect(() => call(e.h, e.client, mod.submitTutorResult, { requestId: req.id, ok: true, result: '{}' })).toThrow(/agent only/);
    call(e.h, e.agent, mod.submitTutorResult, { requestId: req.id, ok: true, result: JSON.stringify({ reply: 'Nice slant.' }) });
    expect(e.h.db.tutorRequest.id.find(req.id)!.status).toBe('done');
    expect(e.h.db.tutorResult.requestId.find(req.id)).toMatchObject({ ok: true });
    expect(() => call(e.h, e.agent, mod.submitTutorResult, { requestId: req.id, ok: true, result: '{}' })).toThrow(/already done/);
  });
});
