// Session map isolation, interruptions and preemptive generation.
import { describe, expect, it } from 'vitest';
import { done, FakeLlm, makeAgent, phrase, session, sleep, tokens, turn, waitFor, type Step, lastUser } from './fakes';

const A = 1n;
const B = 2n;

/** A gate an LLM script can wait on. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>(r => (open = r));
  return { p, open };
}

describe('session isolation', () => {
  it('a slow reply in one session never blocks another', async () => {
    const g = gate();
    const llm = new FakeLlm((_i, msgs) => {
      const last = String(lastUser(msgs)!.content);
      return last.startsWith('slow')
        ? [...tokens('This is the slow session speaking right now. '), ...tokens('And '), { type: 'wait', until: g.p }, ...tokens('it continues after the wait.'), done]
        : [...tokens('This is the fast session and it is done.'), done];
    });
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onSession(session(B));
    agent.onTurn(turn(A, 0, 'slow please'));
    await waitFor(() => transport.of('addSentence', A).length === 1);
    agent.onTurn(turn(B, 0, 'fast please'));
    await waitFor(() => transport.of('appendTutorTurn', B).length === 1);
    expect(transport.of('appendTutorTurn', A)).toHaveLength(0);
    expect(transport.of('appendTutorTurn', B)[0]!.text).toBe('This is the fast session and it is done.');
    // Separate state: different utterances, own sentence counters.
    const ua = agent.sessions.get(A)!.live!.utteranceId;
    const ub = agent.sessions.get(B)!.live!.utteranceId;
    expect(ua).not.toBe(ub);
    expect(transport.of('addSentence', B).map(s => s.idx)).toEqual([0]);
    // Interrupting B does nothing to A.
    agent.onSession(session(B, { turnState: 'interrupted' }));
    g.open();
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    expect(transport.of('appendTutorTurn', A)[0]).toMatchObject({ interrupted: false, utteranceId: ua });
    expect(transport.of('addSentence', A).every(s => s.utteranceId === ua)).toBe(true);
  });

  it('ignores turns of unknown or inactive sessions and answers once the session row arrives', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onTurn(turn(A, 0, 'hello'));
    await sleep(10);
    expect(llm.calls).toHaveLength(0);
    agent.onSession(session(A));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    // Re-delivered rows (reconnect) do not start a second reply.
    agent.onTurn(turn(A, 0, 'hello'));
    agent.onSession(session(A));
    await sleep(10);
    expect(llm.calls).toHaveLength(1);
  });

  it('does not answer a ready turn that is not the latest', async () => {
    const llm = new FakeLlm([]);
    const { agent } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onTurn(turn(A, 1, 'Already answered.', 'done', 'tutor'));
    agent.onTurn(turn(A, 0, 'old'));
    await sleep(10);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('interruptions', () => {
  const slowReply = (g: { p: Promise<void> }): Step[] => [
    ...tokens('Here is the first sentence of my answer. '),
    ...tokens('And here comes the second sentence of it. '),
    ...tokens('This '),
    { type: 'wait', until: g.p },
    ...tokens('third sentence should never be sent.'),
    done,
  ];

  it('turnState interrupted aborts the stream and appends what was actually said', async () => {
    const g = gate();
    const llm = new FakeLlm([slowReply(g)]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'go'));
    await waitFor(() => transport.of('addSentence').length === 2);
    const u = agent.sessions.get(A)!.live!.utteranceId;
    // Sentence 1 was not played yet: the interrupt reducer marks it dropped.
    agent.onSentence({ sessionId: A, utteranceId: u, idx: 0, status: 'played' });
    agent.onSession(session(A, { turnState: 'interrupted' }));
    agent.onSentence({ sessionId: A, utteranceId: u, idx: 1, status: 'dropped' });
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    expect(transport.of('appendTutorTurn')[0]).toEqual({ sessionId: A, utteranceId: u, text: 'Here is the first sentence of my answer.', interrupted: true });
    g.open();
    await sleep(20);
    expect(transport.of('addSentence')).toHaveLength(2);
    expect(transport.of('appendTutorTurn')).toHaveLength(1);
  });

  it('playback_flush for the current utterance interrupts; other utterances are ignored', async () => {
    const g = gate();
    const llm = new FakeLlm([slowReply(g)]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'go'));
    await waitFor(() => transport.of('addSentence').length === 2);
    const u = agent.sessions.get(A)!.live!.utteranceId;
    agent.onPlaybackFlush(A, u + 12345n);
    agent.onPlaybackFlush(B, u);
    await sleep(10);
    expect(llm.calls[0]!.signal.aborted).toBe(false);
    agent.onPlaybackFlush(A, u);
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('appendTutorTurn')[0]).toMatchObject({ interrupted: true, text: 'Here is the first sentence of my answer. And here comes the second sentence of it.' });
    g.open();
  });

  it('a new ready student turn aborts the in-flight reply', async () => {
    const g = gate();
    const llm = new FakeLlm([slowReply(g), [...tokens('Sure, let us talk about the new question.'), done]]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'first'));
    await waitFor(() => transport.of('addSentence').length === 2);
    const u0 = agent.sessions.get(A)!.live!.utteranceId;
    agent.onTurn(turn(A, 1, 'second question'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    const [first, second] = transport.of('appendTutorTurn');
    expect(first).toMatchObject({ utteranceId: u0, interrupted: true });
    expect(second).toMatchObject({ interrupted: false, text: 'Sure, let us talk about the new question.' });
    expect(transport.of('beginUtterance').map(b => b.replyToIdx)).toEqual([0, 1]);
    g.open();
  });
});

describe('preemptive generation', () => {
  const opts = { preemptive: true, preemptiveSilenceMs: 30 };

  function setup(script: Step[][]) {
    const llm = new FakeLlm(script);
    const m = makeAgent(llm, undefined, opts);
    m.agent.onSession(session(A));
    return { llm, ...m };
  }

  it('starts after silence once all phrases are transcribed, holds output, flushes on ready', async () => {
    const { llm, agent, transport } = setup([[...tokens('You said one half, and that is a great start! '), ...tokens('Let us look closer at it now.'), done]]);
    agent.onPhrase(phrase(A, 1, 0, 'streaming'));
    agent.onTurn(turn(A, 0, '', 'open'));
    agent.onSpeechActivity(A);
    agent.onPhrase(phrase(A, 1, 0, 'transcribing'));
    await sleep(50);
    expect(llm.calls).toHaveLength(0); // still transcribing
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Is it one half?'));
    agent.onTurn(turn(A, 0, 'Is it one half?', 'open'));
    await waitFor(() => llm.calls.length === 1);
    await sleep(30);
    // LLM ran, but nothing reached SpacetimeDB except the read-only context call.
    expect(transport.names()).toEqual(['buildContext']);
    agent.onTurn(turn(A, 0, 'Is it one half?', 'closing'));
    await sleep(10);
    expect(transport.names()).toEqual(['buildContext']);
    agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(1);
    expect(transport.of('beginUtterance')[0]).toMatchObject({ preemptive: true, replyToIdx: 0 });
    expect(transport.names()).toEqual(['buildContext', 'beginUtterance', 'addSentence', 'addSentence', 'appendTutorTurn']);
  });

  it('waits PREEMPTIVE_SILENCE_MS after the last speech activity', async () => {
    const { llm, agent } = setup([]);
    agent.onSpeechActivity(A);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Hmm'));
    agent.onTurn(turn(A, 0, 'Hmm', 'open'));
    await sleep(10);
    expect(llm.calls).toHaveLength(0);
    await waitFor(() => llm.calls.length === 1, 500);
  });

  it('speech activity aborts and discards the held reply; the ready turn gets a fresh call', async () => {
    const g = gate();
    const { llm, agent, transport } = setup([
      [...tokens('This answer was for the old transcript only. '), { type: 'wait', until: g.p }, done],
      [...tokens('This is the answer to the full question now.'), done],
    ]);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Is it'));
    agent.onTurn(turn(A, 0, 'Is it', 'open'));
    await waitFor(() => llm.calls.length === 1);
    agent.onSpeechActivity(A);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    agent.onPhrase(phrase(A, 2, 0, 'streaming'));
    agent.onPhrase(phrase(A, 2, 0, 'done', 'one half?'));
    agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('beginUtterance')[0]).toMatchObject({ preemptive: false });
    expect(transport.of('addSentence').map(s => s.display)).toEqual(['This is the answer to the full question now.']);
    g.open();
  });

  it('a changed transcript discards the held reply', async () => {
    const { llm, agent, transport } = setup([[...tokens('Answer for the first version of the text.'), done], []]);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Two'));
    agent.onTurn(turn(A, 0, 'Two', 'open'));
    await waitFor(() => llm.calls.length === 1);
    await sleep(10);
    agent.onTurn(turn(A, 0, 'Two thirds', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    expect(transport.of('beginUtterance')[0]).toMatchObject({ preemptive: false });
    expect(String(lastUser(llm.calls[1]!.messages)!.content)).toBe('Two thirds');
  });

  it('off when PREEMPTIVE_LLM is false', async () => {
    const llm = new FakeLlm([]);
    const { agent } = makeAgent(llm, undefined, { preemptive: false, preemptiveSilenceMs: 5 });
    agent.onSession(session(A));
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Hi'));
    agent.onTurn(turn(A, 0, 'Hi', 'open'));
    await sleep(30);
    expect(llm.calls).toHaveLength(0);
  });

  it('session end discards held and live replies', async () => {
    const g = gate();
    const { llm, agent, transport } = setup([[...tokens('Something to say about this nice topic. '), { type: 'wait', until: g.p }, done]]);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Hi'));
    agent.onTurn(turn(A, 0, 'Hi', 'open'));
    await waitFor(() => llm.calls.length === 1);
    agent.onSessionGone(A);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    expect(agent.sessions.has(A)).toBe(false);
    await sleep(10);
    expect(transport.names()).toEqual(['buildContext']);
    g.open();
  });
});

describe('preemptive start counted from the end of speech', () => {
  type Ag = ReturnType<typeof makeAgent>['agent'];
  /** The phrase's final chunk: speech_activity plus the phrase turning `transcribing` (same commit). */
  function finalChunk(agent: Ag, phraseId = 1, activityFirst = true) {
    if (activityFirst) {
      agent.onSpeechActivity(A, phraseId);
      agent.onPhrase(phrase(A, phraseId, 0, 'transcribing'));
    } else {
      agent.onPhrase(phrase(A, phraseId, 0, 'transcribing'));
      agent.onSpeechActivity(A, phraseId);
    }
  }

  function setup(o: { preemptiveSilenceMs: number; phraseSilenceMs?: number }) {
    const llm = new FakeLlm([]);
    const m = makeAgent(llm, undefined, { preemptive: true, ...o });
    m.agent.onSession(session(A));
    m.agent.onTurn(turn(A, 0, '', 'open'));
    m.agent.onPhrase(phrase(A, 1, 0, 'streaming'));
    m.agent.onSpeechActivity(A, 1);
    return { llm, ...m };
  }

  for (const activityFirst of [true, false]) {
    it(`starts as soon as STT is done when the phrase window covers the silence (${activityFirst ? 'activity first' : 'phrase first'})`, async () => {
      const { llm, agent } = setup({ preemptiveSilenceMs: 200, phraseSilenceMs: 300 });
      finalChunk(agent, 1, activityFirst);
      await sleep(5);
      expect(llm.calls).toHaveLength(0); // still transcribing
      agent.onPhrase(phrase(A, 1, 0, 'done', 'Is it one half?'));
      agent.onTurn(turn(A, 0, 'Is it one half?', 'open'));
      await waitFor(() => llm.calls.length === 1, 60, 'immediate preemptive start');
    });
  }

  it('after the final chunk waits only the rest: PREEMPTIVE_SILENCE_MS - VAD_PHRASE_MS', async () => {
    const { llm, agent } = setup({ preemptiveSilenceMs: 150, phraseSilenceMs: 60 });
    finalChunk(agent);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Two thirds'));
    agent.onTurn(turn(A, 0, 'Two thirds', 'open'));
    const t0 = Date.now();
    await sleep(40);
    expect(llm.calls).toHaveLength(0);
    await waitFor(() => llm.calls.length === 1, 500);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(Date.now() - t0).toBeLessThan(140);
  });

  it('non-final speech activity counts as speech now and resets the wait', async () => {
    const { llm, agent } = setup({ preemptiveSilenceMs: 80, phraseSilenceMs: 300 });
    finalChunk(agent);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Two'));
    agent.onTurn(turn(A, 0, 'Two', 'open'));
    await waitFor(() => llm.calls.length === 1, 60);
    // The student goes on (phrase 2): the early run is aborted; no new one while speaking.
    agent.onPhrase(phrase(A, 2, 0, 'streaming'));
    agent.onSpeechActivity(A, 2);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    for (let i = 0; i < 3; i++) {
      await sleep(40);
      agent.onSpeechActivity(A, 2);
    }
    expect(llm.calls).toHaveLength(1);
    finalChunk(agent, 2);
    agent.onPhrase(phrase(A, 2, 0, 'done', 'thirds'));
    agent.onTurn(turn(A, 0, 'Two thirds', 'open'));
    await waitFor(() => llm.calls.length === 2, 60);
    expect(String(lastUser(llm.calls[1]!.messages)!.content)).toBe('Two thirds');
  });

  it('a non-final chunk alone waits the full PREEMPTIVE_SILENCE_MS', async () => {
    const { llm, agent } = setup({ preemptiveSilenceMs: 80, phraseSilenceMs: 300 });
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Hmm')); // e.g. seen after a reconnect
    agent.onTurn(turn(A, 0, 'Hmm', 'open'));
    await sleep(40);
    expect(llm.calls).toHaveLength(0);
    await waitFor(() => llm.calls.length === 1, 500);
  });

  it('speaking again after an early start aborts and discards; nothing reached SpacetimeDB', async () => {
    const { llm, agent, transport } = setup({ preemptiveSilenceMs: 200, phraseSilenceMs: 300 });
    finalChunk(agent);
    agent.onPhrase(phrase(A, 1, 0, 'done', 'Is it'));
    agent.onTurn(turn(A, 0, 'Is it', 'open'));
    await waitFor(() => llm.calls.length === 1, 60);
    agent.onSpeechActivity(A, 2);
    agent.onPhrase(phrase(A, 2, 0, 'streaming'));
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    await sleep(20);
    expect(transport.names()).toEqual(['buildContext']);
  });
});

describe('context prefetch', () => {
  function setup(opts: Record<string, unknown> = {}) {
    const llm = new FakeLlm([]);
    const m = makeAgent(llm, undefined, opts);
    m.agent.onSession(session(A));
    m.agent.onPhrase(phrase(A, 1, 0, 'done', 'Is it one half?'));
    return { llm, ...m };
  }
  type Ag = ReturnType<typeof setup>['agent'];
  const contexts = (t: ReturnType<typeof setup>['transport']) => t.of('buildContext').length;

  it('builds the context when the turn is closing and reuses it when it is ready', async () => {
    const { llm, agent, transport } = setup();
    agent.onTurn(turn(A, 0, 'Is it one half?', 'closing'));
    expect(contexts(transport)).toBe(1);
    agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(contexts(transport)).toBe(1);
    expect(llm.calls[0]!.messages.some(m => String(m.content).includes(transport.context))).toBe(true);
  });

  it('a preemptive run builds it once for the whole turn', async () => {
    const { llm, agent, transport } = setup({ preemptive: true, preemptiveSilenceMs: 5 });
    agent.onTurn(turn(A, 0, 'Is it one half?', 'open'));
    await waitFor(() => llm.calls.length === 1);
    agent.onTurn(turn(A, 0, 'Is it one half?', 'closing'));
    agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(contexts(transport)).toBe(1);
  });

  it('refetches when phase, topic, board or learner changed in between', async () => {
    const changes: ((a: Ag) => void)[] = [
      a => a.onSession(session(A, { phase: 'other-phase' })),
      a => a.onSession(session(A, { category: 'fractions', concept: 'halves' })),
      a => a.onBoardItem(A),
      a => a.onLearner(),
    ];
    for (const change of changes) {
      const { agent, transport } = setup();
      agent.onTurn(turn(A, 0, 'Is it one half?', 'closing'));
      change(agent);
      agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
      await waitFor(() => transport.of('appendTutorTurn').length === 1);
      expect(contexts(transport)).toBe(2);
    }
  });

  it('turn state changes alone do not invalidate it', async () => {
    const { agent, transport } = setup();
    agent.onTurn(turn(A, 0, 'Is it one half?', 'closing'));
    agent.onSession(session(A, { turnState: 'thinking' }));
    agent.onTurn(turn(A, 0, 'Is it one half?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(contexts(transport)).toBe(1);
  });

  it('a mutating call of a reply invalidates it; an old prefetch expires', async () => {
    const { agent, transport } = setup({ contextTtlMs: 30 });
    agent.onTurn(turn(A, 0, 'first', 'closing'));
    agent.onTurn(turn(A, 0, 'first', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(contexts(transport)).toBe(1);
    // appendTutorTurn ran after the context was built: the next turn fetches again.
    agent.onTurn(turn(A, 2, 'second', 'closing'));
    expect(contexts(transport)).toBe(2);
    await sleep(50); // older than contextTtlMs
    agent.onTurn(turn(A, 2, 'second', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    expect(contexts(transport)).toBe(3);
  });
});
