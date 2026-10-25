import { describe, it, expect } from 'vitest';
import { call, makeLearner, makeSession, mod, pcm, runStt, session, setup, sttOk, turns, type Req } from './helpers';

function start() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  return { ...env, s };
}

describe('pushAudio', () => {
  it('opens a student turn and a phrase on the first chunk and dedupes exact repeats', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(150, 1), final: false });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(150, 1), final: false }); // repeat
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 2, pcm: pcm(150, 3), final: false }); // out of order
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 1, pcm: pcm(150, 2), final: false });
    const [t] = turns(h, s.id);
    expect(t!.role).toBe('student');
    expect(t!.status).toBe('open');
    expect(session(h, s.id).turnCount).toBe(1);
    const p = [...h.db.phrase.sessionId.filter(s.id)];
    expect(p).toHaveLength(1);
    expect(p[0]!.lastSeq).toBe(2);
    expect(p[0]!.bytes).toBe(3 * 150 * 32);
    expect([...h.db.audioIn.sessionId.filter(s.id)]).toHaveLength(3);
  });

  it('final chunk raises pendingPhrases and schedules stt; transcription joins chunks by seq', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 7, seq: 1, pcm: pcm(100, 2), final: false });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 7, seq: 0, pcm: pcm(100, 1), final: false });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 7, seq: 2, pcm: pcm(100, 3), final: true });
    expect(turns(h, s.id)[0]!.pendingPhrases).toBe(1);
    expect([...h.db.sttJob.iter()]).toHaveLength(1);
    expect([...h.db.phrase.iter()][0]!.status).toBe('transcribing');

    let seen: Req | undefined;
    runStt(h, req => {
      seen = req;
      return { status: 200, body: JSON.stringify({ type: 'transcript', text: ' two thirds ', duration: 0.3 }) };
    });
    expect(seen!.uri).toBe('http://127.0.0.1:8787/stt?encoding=pcm_s16le&sample_rate=16000');
    expect(seen!.headers['authorization']).toBe('Bearer cartesia-test');
    expect(seen!.headers['cartesia-version']).toBeTruthy();
    expect(seen!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen!.text).toContain('name="model"\r\n\r\nink-2');
    expect(seen!.text).toContain('name="language"');
    // audio bytes in seq order: 1s then 2s then 3s
    const body = seen!.body;
    const start1 = body.indexOf(1);
    expect(body[start1 + 3200 - 1]).toBe(1);
    expect(body[start1 + 3200]).toBe(2);
    expect(body[start1 + 6400]).toBe(3);

    const t = turns(h, s.id)[0]!;
    expect(t.text).toBe('two thirds');
    expect(t.pendingPhrases).toBe(0);
    expect(t.status).toBe('open');
    expect([...h.db.audioIn.iter()]).toHaveLength(0);
    expect([...h.db.phrase.iter()][0]!.status).toBe('done');
  });

  it('ignores chunks for a phrase that is already transcribed', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(200), final: true });
    runStt(h, sttOk('hello'));
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 1, pcm: pcm(200), final: true });
    expect([...h.db.sttJob.iter()]).toHaveLength(0);
    expect([...h.db.audioIn.iter()]).toHaveLength(0);
  });
});

describe('turn closing', () => {
  it('endTurn with pending phrases -> closing; last transcription -> ready + thinking + metrics', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 2, seq: 0, pcm: pcm(300), final: true });
    call(h, client, mod.endTurn, { sessionId: s.id });
    let t = turns(h, s.id)[0]!;
    expect(t.status).toBe('closing');
    expect(t.pendingPhrases).toBe(2);
    expect(session(h, s.id).turnState).toBe('listening');

    // Phrase 2 finishes first; text order still follows the phrases.
    const jobs = [...h.db.sttJob.iter()].sort((a, b) => b.phraseId - a.phraseId);
    expect(jobs.map(j => j.phraseId)).toEqual([2, 1]);
    const texts: Record<number, string> = { 1: 'I think', 2: 'it is eight twelfths' };
    for (const job of jobs) {
      h.withReducerTx(client, ctx => ctx.db.sttJob.scheduledId.delete(job.scheduledId));
      const ctx = (h as any).procedureContextBuilder(client)
        .http(() => ({ code: 200, headers: { entries: [] }, version: { tag: 'Http11' }, body: JSON.stringify({ text: texts[job.phraseId] }) }))
        .build();
      (mod.transcribePhrase as any)(ctx, { job });
      if (job.phraseId === 2) expect(turns(h, s.id)[0]!.status).toBe('closing');
    }
    t = turns(h, s.id)[0]!;
    expect(t.text).toBe('I think it is eight twelfths');
    expect(t.status).toBe('ready');
    expect(session(h, s.id).turnState).toBe('thinking');
    const m = [...h.db.turnMetrics.sessionId.filter(s.id)][0]!;
    expect(m.turnIdx).toBe(0);
    expect(m.turnEndAt).toBeTruthy();
    expect(m.sttDoneAt).toBeTruthy();
  });

  it('endTurn with nothing pending and text -> ready at once', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    runStt(h, sttOk('yes'));
    call(h, client, mod.endTurn, { sessionId: s.id });
    expect(turns(h, s.id)[0]!.status).toBe('ready');
    expect(session(h, s.id).turnState).toBe('thinking');
  });

  it('speech after endTurn but before ready reopens the same turn', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    call(h, client, mod.endTurn, { sessionId: s.id });
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 2, seq: 0, pcm: pcm(300), final: false });
    expect(turns(h, s.id)).toHaveLength(1);
    expect(turns(h, s.id)[0]!.status).toBe('open');
  });

  it('discards too-short phrases without an STT call and drops a turn without text', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(50), final: true }); // 50 ms < 100 ms
    call(h, client, mod.endTurn, { sessionId: s.id });
    expect(turns(h, s.id)[0]!.status).toBe('closing');
    runStt(h); // no responder: an HTTP call would throw
    // The empty turn is dropped together with its discarded phrase; its idx is free again.
    expect([...h.db.phrase.iter()]).toHaveLength(0);
    expect(turns(h, s.id)).toHaveLength(0);
    expect(session(h, s.id).turnCount).toBe(0);
    expect(session(h, s.id).turnState).toBe('listening');
  });

  it('discards phrases with an empty transcript', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    runStt(h, sttOk('   '));
    expect([...h.db.phrase.iter()][0]!.status).toBe('discarded');
    call(h, client, mod.endTurn, { sessionId: s.id });
    expect(turns(h, s.id)).toHaveLength(0);
  });

  it('retries once on an STT HTTP error, then discards', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    call(h, client, mod.endTurn, { sessionId: s.id });
    runStt(h, () => ({ status: 503, body: 'busy' }));
    const retry = [...h.db.sttJob.iter()];
    expect(retry).toHaveLength(1);
    expect(retry[0]!.attempt).toBe(1);
    expect(turns(h, s.id)[0]!.pendingPhrases).toBe(1);
    runStt(h, () => ({ status: 500, body: 'down' }));
    expect([...h.db.sttJob.iter()]).toHaveLength(0);
    expect([...h.db.phrase.iter()]).toHaveLength(0);
    expect(turns(h, s.id)).toHaveLength(0);
  });

  it('a retry that succeeds fills the turn', () => {
    const { h, client, s } = start();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    runStt(h, () => ({ status: 502 }));
    runStt(h, sttOk('three'));
    expect(turns(h, s.id)[0]!.text).toBe('three');
  });
});
