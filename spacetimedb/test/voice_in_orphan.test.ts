// Orphaned streaming phrase: a reload / tab close / websocket drop while the child speaks leaves a
// phrase without its final chunk. It must not block the turn (or typed turns) forever.
import { describe, it, expect } from 'vitest';
import { TimeDuration } from 'spacetimedb';
import { call, makeLearner, makeSession, mod, pcm, runStt, session, setup, sttOk, turns } from './helpers';
import { ORPHAN_PHRASE_GRACE_MS } from '../src/voice_in';

/** Child says "two thirds" (phrase 1, transcribed), then the page reloads during phrase 2. */
function stuck() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  const { h, client } = env;
  call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
  runStt(h, sttOk('two thirds'));
  call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 2, seq: 0, pcm: pcm(150), final: false }); // never finalized
  call(h, client, mod.endTurn, { sessionId: s.id });
  expect(turns(h, s.id)[0]!.status).toBe('closing'); // the stuck state: no final chunk will ever come
  return { ...env, s };
}

const phrase = (h: ReturnType<typeof setup>['h'], sessionId: bigint, id: number) =>
  [...h.db.phrase.sessionId.filter(sessionId)].find(p => p.phraseId === id)!;

describe('orphaned streaming phrase', () => {
  it('reproduces the block: typed turns are refused while the orphan is fresh', () => {
    const { h, client, s } = stuck();
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'eight twelfths', intent: '' })).toThrow(/still being transcribed/);
  });

  it('a new phrase finalizes the orphan (transcribed like a phrase end) and the turn completes', () => {
    const { h, client, s } = stuck();
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 3, seq: 0, pcm: pcm(300), final: true });
    expect(phrase(h, s.id, 2).status).toBe('transcribing');
    expect(turns(h, s.id)[0]!.pendingPhrases).toBe(2);
    const queue = ['is', 'eight twelfths'];
    expect(runStt(h, () => ({ status: 200, body: JSON.stringify({ text: queue.shift() }) }))).toBe(2);
    call(h, client, mod.endTurn, { sessionId: s.id });
    const t = turns(h, s.id)[0]!;
    expect(t.status).toBe('ready');
    expect(t.text).toBe('two thirds is eight twelfths');
    expect(session(h, s.id).turnState).toBe('thinking');
  });

  it('a stale orphan is discarded on a typed turn, which absorbs the spoken text', () => {
    const { h, client, s } = stuck();
    h.clock.advance(TimeDuration.fromMillis(150 + ORPHAN_PHRASE_GRACE_MS + 100));
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'eight twelfths', intent: '' });
    const all = turns(h, s.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('ready');
    expect(all[0]!.text).toBe('two thirds eight twelfths');
    expect(phrase(h, s.id, 2).status).toBe('discarded');
    expect([...h.db.audioIn.sessionId.filter(s.id)]).toHaveLength(0);
  });
});
