import { describe, it, expect } from 'vitest';
import { auth, call, makeLearner, makeSession, mod, pcm, runTts, session, setup, studentSays, turns, type Req } from './helpers';

function ready() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  studentSays(env.h, env.client, s.id, 'I do not get it');
  return { ...env, s };
}

const ttsOk = (req: Req) => ({ status: 200, body: new Uint8Array(4800).fill(req.text.length % 7) });
const sentences = (h: ReturnType<typeof setup>['h'], utteranceId: bigint) =>
  [...h.db.replySentence.iter()].filter(x => x.utteranceId === utteranceId).sort((a, b) => a.idx - b.idx);

describe('utterances and TTS', () => {
  it('agent-only reducers reject other identities', () => {
    const { h, client, s } = ready();
    expect(() => call(h, client, mod.beginUtterance, { sessionId: s.id, utteranceId: 5n, replyToIdx: 0, preemptive: false })).toThrow(/agent only/);
    expect(() => call(h, auth('stranger'), mod.setTurnState, { sessionId: s.id, state: 'speaking' })).toThrow(/agent only/);
    expect(() => call(h, client, mod.registerAgent, { secret: 'wrong' })).toThrow(/invalid agent secret/);
  });

  it('addSentence -> tts job -> audio, speaking state and metrics', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 11n, replyToIdx: 0, preemptive: false });
    expect(session(h, s.id).currentUtteranceId).toBe(11n);
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 11n, idx: 0, display: 'Let us look.', speech: 'Let us look.' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 11n, idx: 1, display: 'Two thirds.', speech: 'Two thirds.' });
    expect([...h.db.ttsJob.iter()]).toHaveLength(2);
    expect(sentences(h, 11n).map(x => x.status)).toEqual(['pending', 'pending']);

    const reqs: Req[] = [];
    runTts(h, req => {
      reqs.push(req);
      return ttsOk(req);
    });
    expect(reqs[0]!.uri).toBe('https://api.cartesia.ai/tts/bytes');
    expect(reqs[0]!.headers['cartesia-version']).toBe('2026-08-14');
    expect(reqs[0]!.headers['authorization']).toBe('Bearer cartesia-test');
    const body = JSON.parse(reqs[0]!.text);
    expect(body).toMatchObject({
      model_id: 'sonic-3.6',
      transcript: 'Let us look.',
      voice: { mode: 'id' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      generation_config: { speed: 1 },
    });
    expect(sentences(h, 11n).map(x => x.status)).toEqual(['ready', 'ready']);
    expect(session(h, s.id).turnState).toBe('speaking');
    const m = [...h.db.turnMetrics.sessionId.filter(s.id)][0]!;
    expect(m.utteranceId).toBe(11n);
    expect(m.firstSentenceAt).toBeTruthy();
    expect(m.firstAudioAt).toBeTruthy();
  });

  it('rejects sentences of a stale utterance', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 1n, replyToIdx: 0, preemptive: true });
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 2n, replyToIdx: 0, preemptive: false });
    expect(() => call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 0, display: 'x', speech: 'x' })).toThrow(/not current/);
  });

  it('markPlayed + appendTutorTurn -> listening; tutor turn counts as a turn', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 3n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 3n, idx: 0, display: 'Hi.', speech: 'Hi.' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 3n, idx: 1, display: 'Look.', speech: 'Look.' });
    runTts(h, ttsOk);
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 3n, idx: 0 });
    expect([...h.db.turnMetrics.sessionId.filter(s.id)][0]!.firstPlaybackAt).toBeTruthy();
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 3n, text: 'Hi. Look.', interrupted: false });
    expect(session(h, s.id).turnState).toBe('speaking'); // last sentence not played yet
    expect(session(h, s.id).turnCount).toBe(2);
    expect(turns(h, s.id).map(t => [t.role, t.status])).toEqual([
      ['student', 'done'],
      ['tutor', 'done'],
    ]);
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 3n, idx: 1 });
    expect(session(h, s.id).turnState).toBe('listening');
    expect(session(h, s.id).currentUtteranceId).toBe(0n);
  });
});

describe('interrupt', () => {
  it('drops unplayed sentences, flushes, clears the utterance; TTS skips dropped sentences', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 9n, replyToIdx: 0, preemptive: false });
    for (let i = 0; i < 3; i++) call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: i, display: `S${i}.`, speech: `S${i}.` });
    // Only sentence 0 gets synthesized and played before the barge-in.
    const jobs = [...h.db.ttsJob.iter()].sort((a, b) => a.idx - b.idx);
    h.withReducerTx(agent, ctx => {
      for (const j of jobs.slice(1)) ctx.db.ttsJob.scheduledId.delete(j.scheduledId);
    });
    runTts(h, ttsOk);
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 9n, idx: 0 });

    call(h, client, mod.interrupt, { sessionId: s.id });
    expect(session(h, s.id).turnState).toBe('interrupted');
    expect(session(h, s.id).currentUtteranceId).toBe(0n);
    expect(sentences(h, 9n).map(x => x.status)).toEqual(['played', 'dropped', 'dropped']);
    expect(() => call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: 3, display: 'x', speech: 'x' })).toThrow(/not current/);

    // The remaining TTS jobs run late: no HTTP call (no responder -> would throw), no audio.
    h.withReducerTx(agent, ctx => {
      for (const j of jobs.slice(1)) ctx.db.ttsJob.insert({ ...j, scheduledId: 0n });
    });
    expect(runTts(h)).toBe(2);
    expect(sentences(h, 9n).map(x => x.status)).toEqual(['played', 'dropped', 'dropped']);

    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 9n, text: 'S0.', interrupted: true });
    const tutor = turns(h, s.id).find(t => t.role === 'tutor')!;
    expect(tutor.interrupted).toBe(true);
    expect(session(h, s.id).turnState).toBe('listening');
  });

  it('a sentence dropped while TTS is in flight is not emitted', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 4n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 4n, idx: 0, display: 'A.', speech: 'A.' });
    runTts(h, (req, hh) => {
      hh.withReducerTx(client, ctx => (mod.interrupt as any)(ctx, { sessionId: s.id }));
      return ttsOk(req);
    });
    expect(sentences(h, 4n)[0]!.status).toBe('dropped');
    expect(session(h, s.id).turnState).toBe('interrupted');
  });

  it('a barge-in student turn is ordered after the interrupted tutor turn', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 6n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 6n, idx: 0, display: 'So.', speech: 'So.' });
    runTts(h, ttsOk);
    // Student starts talking (turn 1 opens), then the client detects barge-in.
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 900, seq: 0, pcm: pcm(200), final: false });
    call(h, client, mod.interrupt, { sessionId: s.id });
    expect(turns(h, s.id).map(t => [t.idx, t.role])).toEqual([[0, 'student'], [1, 'student']]);
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 6n, text: 'So.', interrupted: true });
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status])).toEqual([
      [0, 'student', 'done'],
      [1, 'tutor', 'done'],
      [2, 'student', 'open'],
    ]);
    expect([...h.db.phrase.iter()].find(p => p.phraseId === 900)!.turnIdx).toBe(2);
    expect(session(h, s.id).turnCount).toBe(3);
  });

  it('TTS failure retries once, then marks the sentence dropped', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 8n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 8n, idx: 0, display: 'A.', speech: 'A.' });
    let calls = 0;
    runTts(h, () => {
      calls++;
      return { status: 500, body: 'nope' };
    });
    expect(calls).toBe(2);
    expect(sentences(h, 8n)[0]!.status).toBe('dropped');
  });
});
