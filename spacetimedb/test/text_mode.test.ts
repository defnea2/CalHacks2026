import { describe, it, expect } from 'vitest';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { readingMs } from '../src/text_mode';
import { auth, call, makeLearner, makeSession, mod, pcm, runStt, runTextPlay, runTts, session, setup, studentSays, turns } from './helpers';

function textSession() {
  const env = setup();
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  call(env.h, env.client, mod.setSessionVoice, { sessionId: s.id, voice: false });
  return { ...env, s };
}
const sentences = (h: ReturnType<typeof setup>['h'], utteranceId: bigint) =>
  [...h.db.replySentence.iter()].filter(x => x.utteranceId === utteranceId).sort((a, b) => a.idx - b.idx);
const jobAt = (j: any): bigint => (typeof j.scheduledAt.value === 'bigint' ? j.scheduledAt.value : j.scheduledAt.value.microsSinceUnixEpoch);

describe('text mode: submitTextTurn', () => {
  it('appends a complete ready student turn in one step (source text, intent kept)', () => {
    const { h, client, s } = textSession();
    expect(session(h, s.id).voice).toBe(false);
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: '  why   twelfths? ', intent: '' });
    const [t] = turns(h, s.id);
    expect(t).toMatchObject({ idx: 0, role: 'student', text: 'why twelfths?', status: 'ready', source: 'text', intent: '' });
    expect(session(h, s.id).turnState).toBe('thinking');
    expect(session(h, s.id).turnCount).toBe(1);
    const m = [...h.db.turnMetrics.sessionId.filter(s.id)][0]!;
    expect(m.turnEndAt).toBeTruthy();
    expect(m.sttDoneAt).toBeTruthy();
  });

  it('button intents: empty text gets the canonical phrase; unknown intents and empty turns are rejected', () => {
    const { h, client, s } = textSession();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: '', intent: 'another_way' });
    expect(turns(h, s.id)[0]).toMatchObject({ text: 'Can you show me another way?', intent: 'another_way', status: 'ready' });
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: 'dance' })).toThrow(/unknown intent/);
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: '   ', intent: '' })).toThrow(/empty turn/);
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'x'.repeat(MODULE_DEFAULTS.TEXT_TURN_MAX_CHARS + 1), intent: '' })).toThrow(/too long/);
  });

  it('rejects ended sessions', () => {
    const { h, client, s } = textSession();
    call(h, client, mod.endSession, { sessionId: s.id });
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: '' })).toThrow(/has ended/);
  });

  it('interrupts a running reply like barge-in; the heard tutor turn goes before the typed turn', () => {
    const { h, agent, client, s } = textSession();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'help', intent: '' });
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 7n, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 0, display: 'Look at the bars.', speech: 'Look at the bars.' });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 7n, idx: 1, display: 'Each bar is one whole.', speech: 'Each bar is one whole.' });
    // Sentence 0 was read; sentence 1 is still on screen.
    const first = [...h.db.textPlayJob.iter()].sort((a, b) => (jobAt(a) < jobAt(b) ? -1 : 1))[0]!;
    runTextPlay(h, jobAt(first));
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'wait, what?', intent: '' });
    expect(sentences(h, 7n).map(x => x.status)).toEqual(['played', 'dropped']);
    expect([...h.db.playbackFlush.iter()].length).toBeGreaterThanOrEqual(0); // event table (not retained)
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status, t.text, t.interrupted])).toEqual([
      [0, 'student', 'done', 'help', false],
      [1, 'tutor', 'done', 'Look at the bars.', true],
      [2, 'student', 'ready', 'wait, what?', false],
    ]);
    expect(session(h, s.id)).toMatchObject({ turnState: 'thinking', currentUtteranceId: 0n, turnCount: 3 });
    // The worker's own appendTutorTurn for the interrupted reply is then a no-op.
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 7n, text: 'Look at the bars. Each bar is one whole.', interrupted: true });
    expect(turns(h, s.id)).toHaveLength(3);
    // The remaining reading job finds the sentence dropped.
    runTextPlay(h);
    expect(sentences(h, 7n).map(x => x.status)).toEqual(['played', 'dropped']);
    // The next reply answers the typed turn.
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 8n, replyToIdx: 2, preemptive: false });
    expect(session(h, s.id).currentUtteranceId).toBe(8n);
  });

  it('an interrupt before anything was read records no tutor text', () => {
    const { h, agent, client, s } = textSession();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'help', intent: '' });
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 9n, replyToIdx: 0, preemptive: false });
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'never mind', intent: 'smaller_step' });
    expect(turns(h, s.id).map(t => [t.idx, t.role, t.status, t.intent])).toEqual([
      [0, 'student', 'done', ''],
      [1, 'student', 'ready', 'smaller_step'],
    ]);
  });

  it('a typed turn in a voice session joins a live, transcribed spoken turn; refused while transcription is pending', () => {
    const env = setup();
    const learner = makeLearner(env.h, env.client);
    const s = makeSession(env.h, env.client, learner.id);
    const { h, client } = env;
    call(h, client, mod.pushAudio, { sessionId: s.id, phraseId: 1, seq: 0, pcm: pcm(300), final: true });
    expect(() => call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'and this', intent: '' })).toThrow(/being transcribed/);
    // Transcribed, turn still open (no endTurn yet): the typed text completes it.
    runStt(h, () => ({ status: 200, body: JSON.stringify({ text: 'two thirds' }) }));
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'is it eight?', intent: '' });
    expect(turns(h, s.id).map(t => [t.idx, t.text, t.status, t.source])).toEqual([[0, 'two thirds is it eight?', 'ready', 'text']]);
  });
});

describe('text mode: sentences without TTS', () => {
  it('voice=false: no tts_job; ready at once; played after the computed reading delay, one after another; thinking -> speaking -> listening', () => {
    const { h, agent, client, s } = textSession();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'help', intent: '' });
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 21n, replyToIdx: 0, preemptive: false });
    expect(session(h, s.id).turnState).toBe('thinking');
    const a = 'Look at the two bars side by side.';
    const b = 'Both wholes are the same size.';
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 21n, idx: 0, display: a, speech: a });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: 21n, idx: 1, display: b, speech: b });
    expect([...h.db.ttsJob.iter()]).toHaveLength(0);
    expect(runTts(h)).toBe(0);
    expect(sentences(h, 21n).map(x => x.status)).toEqual(['ready', 'ready']);
    expect(session(h, s.id).turnState).toBe('speaking');
    const jobs = [...h.db.textPlayJob.iter()].sort((x, y) => (jobAt(x) < jobAt(y) ? -1 : 1));
    expect(jobs).toHaveLength(2);
    const created = sentences(h, 21n)[0]!.createdAt.microsSinceUnixEpoch;
    expect(jobAt(jobs[0]!) - created).toBe(BigInt(readingMs(a)) * 1000n);
    expect(jobAt(jobs[1]!) - jobAt(jobs[0]!)).toBe(BigInt(readingMs(b)) * 1000n);
    expect(readingMs(a)).toBe(8 * MODULE_DEFAULTS.TEXT_SENTENCE_MS_PER_WORD);
    const m = [...h.db.turnMetrics.sessionId.filter(s.id)][0]!;
    expect(m.firstSentenceAt && m.firstAudioAt && m.firstPlaybackAt).toBeTruthy();

    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: 21n, text: `${a} ${b}`, interrupted: false });
    expect(session(h, s.id).turnState).toBe('speaking'); // still reading
    runTextPlay(h, jobAt(jobs[0]!));
    expect(sentences(h, 21n).map(x => x.status)).toEqual(['played', 'ready']);
    expect(session(h, s.id).turnState).toBe('speaking');
    runTextPlay(h);
    expect(sentences(h, 21n).map(x => x.status)).toEqual(['played', 'played']);
    expect(session(h, s.id)).toMatchObject({ turnState: 'listening', currentUtteranceId: 0n });
  });

  it('the scheduled reducer is scheduler-only; short sentences get the minimum reading time', () => {
    const { h, client } = textSession();
    expect(() => call(h, client, mod.finishTextSentence as any, { job: { scheduledId: 1n, sessionId: 1n, sentenceId: 1n, utteranceId: 1n, idx: 0 } })).toThrow(/scheduler only/);
    expect(readingMs('Yes.')).toBe(MODULE_DEFAULTS.TEXT_SENTENCE_MIN_MS);
    expect(() => call(h, auth('x'), mod.setSessionVoice, { sessionId: 999n, voice: false })).toThrow(/not found/);
  });

  it('voice sessions are unchanged (tts_job per sentence)', () => {
    const env = setup();
    const learner = makeLearner(env.h, env.client);
    const s = makeSession(env.h, env.client, learner.id);
    studentSays(env.h, env.client, s.id, 'hello');
    expect(session(env.h, s.id).voice).toBe(true);
    expect(turns(env.h, s.id)[0]!.source).toBe('voice');
    call(env.h, env.agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 31n, replyToIdx: 0, preemptive: false });
    call(env.h, env.agent, mod.addSentence, { sessionId: s.id, utteranceId: 31n, idx: 0, display: 'Hi.', speech: 'Hi.' });
    expect([...env.h.db.ttsJob.iter()]).toHaveLength(1);
    expect([...env.h.db.textPlayJob.iter()]).toHaveLength(0);
  });
});
