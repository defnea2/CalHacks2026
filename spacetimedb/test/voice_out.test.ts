import { describe, it, expect } from 'vitest';
import { base64, fromBase64, parseTtsSse } from '../src/providers';
import { audioRow } from '../src/voice_out';
import { auth, call, makeLearner, makeSession, mod, pcm, runTts, session, setup, studentSays, ttsSse, turns, type Req } from './helpers';

function ready() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  studentSays(env.h, env.client, s.id, 'I do not get it');
  return { ...env, s };
}

const ttsOk = (req: Req) => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(req.text.length % 7)) });
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
    expect(reqs[0]!.uri).toBe('https://api.cartesia.ai/tts/sse');
    expect(reqs[0]!.headers['cartesia-version']).toBe('2026-08-14');
    expect(reqs[0]!.headers['authorization']).toBe('Bearer cartesia-test');
    const body = JSON.parse(reqs[0]!.text);
    expect(body).toMatchObject({
      model_id: 'sonic-3.6',
      transcript: 'Let us look.',
      voice: { mode: 'id' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      generation_config: { speed: 1 },
      add_timestamps: true,
    });
    expect(sentences(h, 11n).map(x => x.status)).toEqual(['ready', 'ready']);
    expect(session(h, s.id).turnState).toBe('speaking');
    const m = [...h.db.turnMetrics.sessionId.filter(s.id)][0]!;
    expect(m.utteranceId).toBe(11n);
    expect(m.firstSentenceAt).toBeTruthy();
    expect(m.firstAudioAt).toBeTruthy();
  });

  it('rejects sentences of a stale utterance', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 1n, replyToIdx: 0, preemptive: true });
    call(h, client, mod.interrupt, { sessionId: s.id });
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 2n, replyToIdx: 0, preemptive: false });
    expect(() => call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 0, display: 'x', speech: 'x' })).toThrow(/not current/);
  });

  it('keeps the first reply when a second one starts for the same turn (e.g. two workers)', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 1n, replyToIdx: 0, preemptive: false });
    expect(() => call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 2n, replyToIdx: 0, preemptive: false })).toThrow(
      /already being answered/
    );
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 1n, idx: 0, display: 'Hi.', speech: 'Hi.' });
    expect(session(h, s.id).currentUtteranceId).toBe(1n);
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

    // The remaining TTS jobs run late: the HTTP call may happen (no pre-check), but the
    // insert transaction sees `dropped` and emits no audio (audio_out and `ready` are written
    // together, so a sentence that stays `dropped` got none).
    h.withReducerTx(agent, ctx => {
      for (const j of jobs.slice(1)) ctx.db.ttsJob.insert({ ...j, scheduledId: 0n });
    });
    expect(runTts(h, ttsOk)).toBe(2);
    expect(sentences(h, 9n).map(x => x.status)).toEqual(['played', 'dropped', 'dropped']);

    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 9n, text: 'S0.', interrupted: true });
    const tutor = turns(h, s.id).find(t => t.role === 'tutor')!;
    expect(tutor.interrupted).toBe(true);
    expect(session(h, s.id).turnState).toBe('listening');
  });

  it('interrupt after the tutor turn was appended marks it interrupted and keeps only heard sentences', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 21n, replyToIdx: 0, preemptive: false });
    for (let i = 0; i < 3; i++) call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 21n, idx: i, display: `S${i}.`, speech: `S${i}.` });
    runTts(h, ttsOk);
    // The LLM finished: the worker appends the full text before playback ends.
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 21n, text: 'S0. S1. S2.', interrupted: false });
    call(h, client, mod.markPlayed, { sessionId: s.id, utteranceId: 21n, idx: 0 });
    call(h, client, mod.interrupt, { sessionId: s.id });
    const tutor = turns(h, s.id).find(t => t.role === 'tutor')!;
    expect(tutor.interrupted).toBe(true);
    expect(tutor.text).toBe('S0.');
    expect(sentences(h, 21n).map(x => x.status)).toEqual(['played', 'dropped', 'dropped']);
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

  it('TTS failure retries once as a new tts_job row (attempt 1), then marks the sentence dropped', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 8n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 8n, idx: 0, display: 'A.', speech: 'A.' });
    expect([...h.db.ttsJob.iter()].map(j => j.attempt)).toEqual([0]);
    let calls = 0;
    const fail = () => {
      calls++;
      return { status: 500, body: 'nope' };
    };
    expect(runTts(h, fail)).toBe(1);
    expect(calls).toBe(1);
    const retry = [...h.db.ttsJob.iter()];
    expect(retry.map(j => [j.attempt, j.sentenceId, j.idx])).toEqual([[1, sentences(h, 8n)[0]!.id, 0]]);
    expect(sentences(h, 8n)[0]!.status).toBe('pending');
    expect(runTts(h, fail)).toBe(1);
    expect(calls).toBe(2);
    expect([...h.db.ttsJob.iter()]).toHaveLength(0);
    expect(sentences(h, 8n)[0]!.status).toBe('dropped');
  });

  it('a failed TTS call whose retry succeeds plays; a barge-in cancels a scheduled retry', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 9n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: 0, display: 'A.', speech: 'A.' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: 1, display: 'B.', speech: 'B.' });
    let n = 0;
    runTts(h, req => (n++ === 0 ? { status: 503, body: 'busy' } : ttsOk(req)));
    expect(sentences(h, 9n).map(x => x.status)).toEqual(['pending', 'ready']);
    runTts(h, ttsOk);
    expect(sentences(h, 9n).map(x => x.status)).toEqual(['ready', 'ready']);

    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 9n, idx: 2, display: 'C.', speech: 'C.' });
    runTts(h, () => ({ status: 500, body: 'nope' }));
    expect([...h.db.ttsJob.iter()].map(j => j.attempt)).toEqual([1]);
    call(h, client, mod.interrupt, { sessionId: s.id });
    expect([...h.db.ttsJob.iter()]).toHaveLength(0);
  });
});

describe('cancelled replies delete their pending tts_job rows (no Cartesia call for dropped sentences)', () => {
  const jobsOf = (h: ReturnType<typeof setup>['h'], utteranceId: bigint) => [...h.db.ttsJob.iter()].filter(j => j.utteranceId === utteranceId);

  it('barge-in (interrupt / interruptUtterance)', () => {
    for (const reducer of [mod.interrupt, mod.interruptUtterance]) {
      const { h, agent, client, s } = ready();
      call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 41n, replyToIdx: 0, preemptive: false });
      for (let i = 0; i < 3; i++) call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 41n, idx: i, display: `S${i}.`, speech: `S${i}.` });
      expect(jobsOf(h, 41n)).toHaveLength(3);
      call(h, client, reducer, { sessionId: s.id, utteranceId: 41n });
      expect(jobsOf(h, 41n)).toHaveLength(0);
      let calls = 0;
      runTts(h, req => {
        calls++;
        return ttsOk(req);
      });
      expect(calls).toBe(0);
      expect(sentences(h, 41n).map(x => x.status)).toEqual(['dropped', 'dropped', 'dropped']);
    }
  });

  it("supersede by a newer reply keeps only the new reply's jobs", () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 42n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 42n, idx: 0, display: 'Old.', speech: 'Old.' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 42n, idx: 1, display: 'Old2.', speech: 'Old2.' });
    studentSays(h, client, s.id, 'wait, another question');
    const latest = turns(h, s.id).filter(t => t.role === 'student').at(-1)!;
    expect(session(h, s.id).currentUtteranceId).toBe(42n);
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 43n, replyToIdx: latest.idx, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 43n, idx: 0, display: 'New.', speech: 'New.' });
    expect(jobsOf(h, 42n)).toHaveLength(0);
    expect(jobsOf(h, 43n)).toHaveLength(1);
    expect(sentences(h, 42n).map(x => x.status)).toEqual(['dropped', 'dropped']);
  });

  it('endSession deletes every pending job of the session', () => {
    const { h, agent, client, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 44n, replyToIdx: 0, preemptive: false });
    for (let i = 0; i < 2; i++) call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 44n, idx: i, display: `S${i}.`, speech: `S${i}.` });
    call(h, client, mod.endSession, { sessionId: s.id });
    expect([...h.db.ttsJob.iter()].filter(j => j.sessionId === s.id)).toHaveLength(0);
    expect(runTts(h, ttsOk)).toBe(0);
  });
});

describe('TTS word timestamps (Cartesia /tts/sse)', () => {
  it('parses audio chunks and word timestamps; fromBase64 inverts base64', () => {
    const audio = new Uint8Array(1001).map((_, i) => (i * 37) % 256);
    expect([...fromBase64(base64(audio))]).toEqual([...audio]);
    const r = parseTtsSse(ttsSse(audio, [['Here', 0.118, 0.28], ['are', 0.36, 0.44], ['two', 0.52, 0.6]]));
    expect([...r.pcm]).toEqual([...audio]);
    expect(r.words).toEqual({ words: ['Here', 'are', 'two'], startsMs: [118, 360, 520], endsMs: [280, 440, 600] });
  });

  it('an error event or an empty stream is a provider error', () => {
    expect(() => parseTtsSse('event: error\ndata: {"type":"error","title":"Bad","message":"voice"}\n\n')).toThrow(/tts error: Bad voice/);
    expect(() => parseTtsSse('event: done\ndata: {"type":"done","done":true}\n\n')).toThrow(/empty audio/);
  });

  it('stores word timings with the sentence audio (event row built by audioRow)', () => {
    const { h, agent, s } = ready();
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 31n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 31n, idx: 0, display: 'Here are two.', speech: 'Here are two.' });
    runTts(h, () => ({ status: 200, body: ttsSse(new Uint8Array(4800).fill(3), [['Here', 0.1, 0.2], ['are', 0.3, 0.4], ['two.', 0.5, 0.9]]) }));
    expect(sentences(h, 31n)[0]!.status).toBe('ready');
    const audio = parseTtsSse(ttsSse(new Uint8Array(8), [['Here', 0.1, 0.2], ['two.', 0.5, 0.9]]));
    expect(audioRow({ sessionId: 1n, utteranceId: 31n, idx: 0 }, { ...audio, sampleRate: 24000 })).toMatchObject({
      words: ['Here', 'two.'],
      wordStartsMs: [100, 500],
      wordEndsMs: [200, 900],
    });
    expect(audioRow({ sessionId: 1n, utteranceId: 31n, idx: 0 }, { pcm: new Uint8Array(2), sampleRate: 24000 })).toMatchObject({ words: [], wordStartsMs: [], wordEndsMs: [] });
  });
});
