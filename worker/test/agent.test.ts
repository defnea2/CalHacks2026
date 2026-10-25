// Session map isolation, interruptions and preemptive generation.
import { describe, expect, it } from 'vitest';
import { done, FakeLlm, makeAgent, phrase, session, sleep, tokens, turn, waitFor, type Step } from './fakes';

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
      const last = String(msgs.at(-1)!.content);
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
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toBe('Two thirds');
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
