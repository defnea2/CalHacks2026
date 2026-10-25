// Barge-in after the tutor turn was appended, and superseded utterances.
import { describe, it, expect } from 'vitest';
import type { Req } from './helpers';
import { call, makeLearner, makeSession, mod, runTts, session, setup, studentSays, ttsSse, turns } from './helpers';

function ready() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  studentSays(env.h, env.client, s.id, 'I do not get it');
  return { ...env, s };
}

const ttsOk = (req: Req) => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(req.text.length % 7)) });
const statuses = (h: ReturnType<typeof setup>['h'], utteranceId: bigint) =>
  [...h.db.replySentence.iter()].filter(x => x.utteranceId === utteranceId).sort((a, b) => a.idx - b.idx).map(x => x.status);

describe('barge-in after the tutor turn was appended', () => {
  it('goes to listening (not stuck in interrupted), also when the worker re-sends the turn', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 21n, replyToIdx: 0, preemptive: false });
    for (let i = 0; i < 3; i++) call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 21n, idx: i, display: `S${i}.`, speech: `S${i}.` });
    runTts(h, ttsOk);
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 21n, text: 'S0. S1. S2.', interrupted: false });
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 21n, idx: 0 });
    call(h, client, mod.interrupt, { sessionId: s.id });
    expect(turns(h, s.id).find(t => t.role === 'tutor')!.interrupted).toBe(true);
    expect(session(h, s.id).turnState).toBe('listening');
    expect(session(h, s.id).currentUtteranceId).toBe(0n);
    // A worker that reports the interruption anyway is a no-op and keeps listening.
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 21n, text: 'S0.', interrupted: true });
    expect(session(h, s.id).turnState).toBe('listening');
  });

  it('an appendTutorTurn for an already-interrupted turn clears a leftover interrupted state', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 22n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 22n, idx: 0, display: 'S0.', speech: 'S0.' });
    runTts(h, ttsOk);
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 22n, text: 'S0.', interrupted: false });
    call(h, client, mod.interrupt, { sessionId: s.id });
    // Simulate the pre-fix leftover state.
    h.withReducerTx(agent, ctx => ctx.db.session.id.update({ ...ctx.db.session.id.find(s.id)!, turnState: 'interrupted' }));
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 22n, text: 'S0.', interrupted: true });
    expect(session(h, s.id).turnState).toBe('listening');
  });
});

describe('superseded utterance', () => {
  it('drops its pending/ready sentences and flushes it for clients; its TTS emits nothing', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 1n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 0, display: 'A.', speech: 'A.' });
    runTts(h, ttsOk);
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 1n, idx: 0 });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 1, display: 'B.', speech: 'B.' }); // ready after TTS
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 2, display: 'C.', speech: 'C.' });
    const jobs = [...h.db.ttsJob.iter()].sort((a, b) => a.idx - b.idx);
    h.withReducerTx(agent, ctx => ctx.db.ttsJob.scheduledId.delete(jobs[1]!.scheduledId)); // C still in flight later
    runTts(h, ttsOk);
    expect(statuses(h, 1n)).toEqual(['played', 'ready', 'pending']);

    // The student spoke again; the worker starts a new reply before the old one ended.
    studentSays(h, client, s.id, 'what about thirds');
    const flushes: Array<{ utteranceId: bigint }> = [];
    // playback_flush is an event table: its rows are only visible inside the transaction.
    h.withReducerTx(agent, ctx => {
      (mod.beginUtterance as any)(ctx, { sessionId: s.id, utteranceId: 2n, replyToIdx: 1, preemptive: false });
      for (const f of (ctx.db.playbackFlush as any).iter()) flushes.push(f);
    });
    expect(session(h, s.id).currentUtteranceId).toBe(2n);
    expect(statuses(h, 1n)).toEqual(['played', 'dropped', 'dropped']);
    expect(flushes.map(f => f.utteranceId)).toContain(1n);
    // The old sentence's TTS finishes late: no audio, stays dropped.
    h.withReducerTx(agent, ctx => ctx.db.ttsJob.insert({ ...jobs[1]!, scheduledId: 0n }));
    runTts(h, ttsOk);
    expect(statuses(h, 1n)).toEqual(['played', 'dropped', 'dropped']);
  });
});
