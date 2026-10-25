// Barge-in after the tutor turn was appended.
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
