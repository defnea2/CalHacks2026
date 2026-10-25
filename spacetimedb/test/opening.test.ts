// The tutor speaks first: startConversation (client) -> beginOpening (agent) -> sentences ->
// appendTutorTurn, without a student turn to answer.
import { describe, it, expect } from 'vitest';
import { OPENING_TURN_IDX } from '../../shared/src/types';
import { auth, call, makeLearner, makeSession, mod, pcm, runTts, session, setup, studentSays, ttsSse, turns, type Req } from './helpers';

const ttsOk = (_req: Req) => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(1)) });

function fresh() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  return { ...env, s };
}
const metrics = (h: ReturnType<typeof setup>['h'], id: bigint) => [...h.db.turnMetrics.sessionId.filter(id)];

describe('opening utterance', () => {
  it('startConversation on a fresh session -> thinking + opening metrics row with turnEndAt; idempotent', () => {
    const { h, client, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(session(h, s.id).turnState).toBe('thinking');
    const m = metrics(h, s.id);
    expect(m).toHaveLength(1);
    expect(m[0]!).toMatchObject({ turnIdx: OPENING_TURN_IDX, utteranceId: 0n });
    expect(m[0]!.turnEndAt).toBeTruthy();
    // A second click / a reload does nothing; another device may not.
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(() => call(h, auth('other-device'), mod.startConversation, { sessionId: s.id })).toThrow(/another device/);
    expect(metrics(h, s.id)).toHaveLength(1);
    expect(turns(h, s.id)).toHaveLength(0);
  });

  it('full flow: beginOpening, sentences, metrics, tutor turn 0, listening; then the student answers', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(() => call(h, client, mod.beginOpening, { sessionId: s.id, utteranceId: 7n })).toThrow(/agent only/);
    call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n });
    expect(session(h, s.id).currentUtteranceId).toBe(7n);
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 0, display: 'Hi Mia!', speech: 'Hi Mia!' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 1, display: 'How do you want to start?', speech: 'How do you want to start?' });
    call(h, agent, mod.recordMetric, { sessionId: s.id, turnIdx: OPENING_TURN_IDX, name: 'llmFirstTokenAt', atMicros: 0n });
    runTts(h, ttsOk);
    expect(session(h, s.id).turnState).toBe('speaking');
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 7n, idx: 0 });
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 7n, text: 'Hi Mia! How do you want to start?', interrupted: false });
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 7n, idx: 1 });

    const m = metrics(h, s.id);
    expect(m).toHaveLength(1);
    expect(m[0]!).toMatchObject({ turnIdx: OPENING_TURN_IDX, utteranceId: 7n, preemptive: false });
    for (const k of ['turnEndAt', 'llmFirstTokenAt', 'firstSentenceAt', 'firstAudioAt', 'firstPlaybackAt'] as const) expect(m[0]![k], k).toBeTruthy();
    expect(m[0]!.firstPlaybackAt!.microsSinceUnixEpoch).toBeGreaterThanOrEqual(m[0]!.turnEndAt!.microsSinceUnixEpoch);
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status, t.utteranceId])).toEqual([[0, 'tutor', 'done', 7n]]);
    expect(session(h, s.id)).toMatchObject({ turnState: 'listening', currentUtteranceId: 0n, turnCount: 1 });

    // Accepted once: no second opening, and startConversation is a no-op now.
    expect(() => call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 8n })).toThrow(/already started/);
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(session(h, s.id).turnState).toBe('listening');

    // The student's answer is turn 1 and gets a normal reply.
    studentSays(h, client, s.id, 'Just guide me please');
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status])).toEqual([[0, 'tutor', 'done'], [1, 'student', 'ready']]);
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 9n, replyToIdx: 1, preemptive: false });
    expect(metrics(h, s.id).map(x => x.turnIdx).sort()).toEqual([1, OPENING_TURN_IDX]);
  });

  it('is not accepted without startConversation or after turns exist', () => {
    const { h, client, agent, s } = fresh();
    expect(() => call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n })).toThrow(/no opening was requested/);
    studentSays(h, client, s.id, 'Hello?');
    // startConversation after the student already spoke: no opening.
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(metrics(h, s.id).some(m => m.turnIdx === OPENING_TURN_IDX)).toBe(false);
    expect(() => call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n })).toThrow(/no opening was requested/);
  });

  it('is rejected when the student finished a turn between the click and beginOpening', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    studentSays(h, client, s.id, 'I need help with fractions');
    expect(() => call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n })).toThrow(/conversation already started/);
    expect(() => call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 0n })).toThrow(/non-zero/);
  });

  it('a student turn opened during the opening is ordered after the tutor turn', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 0, display: 'Hi!', speech: 'Hi!' });
    runTts(h, ttsOk);
    // Student barges in: turn 0 opens, interrupt.
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 900, seq: 0, pcm: pcm(200), final: false });
    call(h, client, mod.interrupt, { sessionId: s.id });
    expect(session(h, s.id).turnState).toBe('interrupted');
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 7n, text: '', interrupted: true });
    // Nothing was heard -> no tutor turn; the student turn stays.
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status])).toEqual([[0, 'student', 'open']]);
    expect(session(h, s.id).turnState).toBe('listening');
  });

  it('heard part of an interrupted opening becomes turn 0, the barge-in student turn moves to 1', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: 7n });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 0, display: 'Hi!', speech: 'Hi!' });
    runTts(h, ttsOk);
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 7n, idx: 0 });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 900, seq: 0, pcm: pcm(200), final: false });
    call(h, client, mod.interrupt, { sessionId: s.id });
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 7n, text: 'Hi!', interrupted: true });
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status])).toEqual([[0, 'tutor', 'done'], [1, 'student', 'open']]);
    expect([...h.db.phrase.iter()].find(p => p.phraseId === 900)!.turnIdx).toBe(1);
    expect(metrics(h, s.id).find(m => m.turnIdx === OPENING_TURN_IDX)!.utteranceId).toBe(7n);
  });
});
