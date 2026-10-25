// The tutor speaks first (opening reply) and the per-call phase prompt swap.
import { describe, expect, it } from 'vitest';
import { OPENING_TURN_IDX, pack, TOOL_NAMES } from '@tutor/shared';
import { done, FakeLlm, makeAgent, phrase, session, sleep, tokens, tool, turn, waitFor } from './fakes';

const S = 1n;
const category = pack.taxonomy[0]!.key;
const [p0, p1, p2] = pack.phases;
const sys = (llm: FakeLlm, i: number) => String(llm.calls[i]!.messages[0]!.content);

describe('opening reply', () => {
  it('thinking on a session without turns -> opening via beginOpening, pack opening prompt, metrics at OPENING_TURN_IDX', async () => {
    const llm = new FakeLlm([[...tokens('Hi Mia, great to see you! '), ...tokens('I see you are expanding two thirds. Should I guide you, or where are you stuck?'), done]]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { turnState: 'thinking' }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1, 2000, 'appendTutorTurn');
    const u = agent.sessions.get(S)!.live!.utteranceId;
    expect(transport.names()).toEqual(['buildContext', 'beginOpening', 'addSentence', 'addSentence', 'addSentence', 'appendTutorTurn']);
    expect(transport.of('beginOpening')[0]).toEqual({ sessionId: S, utteranceId: u });
    expect(transport.of('beginUtterance')).toHaveLength(0);
    expect(transport.of('addSentence')[0]!.display).toBe('Hi Mia, great to see you!');
    expect(transport.of('appendTutorTurn')[0]).toMatchObject({ utteranceId: u, interrupted: false });
    expect(transport.of('recordMetric').every(m => m.turnIdx === OPENING_TURN_IDX)).toBe(true);
    // Prompt: system + context + the opening instruction, no student turn.
    const msgs = llm.calls[0]!.messages;
    expect(msgs.at(-1)).toEqual({ role: 'user', content: pack.prompts.opening });
    expect(msgs.filter(m => m.role === 'user')).toHaveLength(1);
    expect(llm.calls[0]!.tools.length).toBeGreaterThan(0);
    // Further session updates (speaking, listening, the new turn) never open again.
    agent.onSession(session(S, { turnState: 'speaking', currentUtteranceId: u }));
    agent.onTurn({ ...turn(S, 0, 'Hi Mia! I see ...', 'done', 'tutor'), utteranceId: u });
    agent.onSession(session(S, { turnState: 'listening', turnCount: 1 }));
    agent.onSession(session(S, { turnState: 'thinking', turnCount: 1 }));
    await sleep(10);
    expect(transport.of('beginOpening')).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('includes the task photo in the opening', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    transport.image = 'data:image/jpeg;base64,AAAA';
    agent.onSession(session(S, { turnState: 'thinking', hasImage: true }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls[0]!.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))).toBe(true);
    expect(agent.sessions.get(S)!.imageSent).toBe(true);
  });

  it('no opening on reload / observer states: listening, turns exist, utterance running, turns not loaded yet', async () => {
    const llm = new FakeLlm([]);
    const { agent } = makeAgent(llm);
    agent.onSession(session(1n)); // listening: nobody clicked "Start talking"
    agent.onSession(session(2n, { turnState: 'thinking', turnCount: 2 })); // a student turn is being answered
    agent.onTurn(turn(2n, 0, 'Hi', 'done'));
    agent.onTurn({ ...turn(2n, 1, 'Hello', 'done', 'tutor') });
    agent.onSession(session(3n, { turnState: 'thinking', currentUtteranceId: 5n })); // opening already speaking
    agent.onSession(session(4n, { turnState: 'thinking', turnCount: 1 })); // turn row not delivered yet
    await sleep(20);
    expect(llm.calls).toHaveLength(0);
    // Once the missing turn arrives and it is a finished student turn: answered, not greeted.
    agent.onTurn(turn(4n, 0, 'Can you help me?'));
    await waitFor(() => llm.calls.length === 1);
    expect(llm.calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'Can you help me?' });
  });

  it('an open student turn (noise right after the click) does not block the opening', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onTurn(turn(S, 0, '', 'open'));
    agent.onPhrase(phrase(S, 1, 0, 'streaming'));
    agent.onSession(session(S, { turnState: 'thinking', turnCount: 1 }));
    await waitFor(() => transport.of('beginOpening').length === 1);
  });

  it('a student turn that becomes ready during the opening interrupts it and is answered', async () => {
    let release!: () => void;
    const g = new Promise<void>(r => (release = r));
    const llm = new FakeLlm(i =>
      i === 0
        ? [...tokens('Hello there, my friend, nice to see you! And '), { type: 'wait', until: g }, ...tokens('This part is never said.'), done]
        : [...tokens('Sure, let us look at it.'), done]
    );
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { turnState: 'thinking' }));
    await waitFor(() => transport.of('addSentence').length === 1);
    agent.onTurn(turn(S, 0, 'I need help with fractions'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    release();
    expect(transport.of('appendTutorTurn')[0]).toMatchObject({ interrupted: true });
    expect(transport.of('beginUtterance')[0]).toMatchObject({ replyToIdx: 0 });
    expect(transport.of('beginOpening')).toHaveLength(1);
  });
});

describe('phase instructions in the system prompt', () => {
  it('contains only the current phase block, taken from the session row', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { phase: p2!.id }));
    agent.onTurn(turn(S, 0, 'ok'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    const s = sys(llm, 0);
    expect(s).toContain(p2!.instructions);
    for (const p of pack.phases) if (p.id !== p2!.id) expect(s).not.toContain(p.instructions);
    expect(s).not.toMatch(/\{\{\w+\}\}/);
  });

  it('a successful set_phase swaps the whole block for the next LLM round of the same reply', async () => {
    const llm = new FakeLlm([
      [...tokens('Fractions, nice. '), tool(TOOL_NAMES.setTopic, { category }), tool(TOOL_NAMES.setPhase, { phase: p1!.id, reason: 'found the gap' }), done],
      [...tokens('Picture a pizza cut into three slices. How many slices do you get?'), done],
    ]);
    const { agent, transport, logs } = makeAgent(llm);
    agent.onSession(session(S, { phase: p0!.id }));
    agent.onTurn(turn(S, 0, 'I do not get fractions.'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(sys(llm, 0)).toContain(p0!.instructions);
    expect(sys(llm, 0)).not.toContain(p1!.instructions);
    // Round 2 (the subscription has NOT delivered the new phase yet): new block, old one gone.
    expect(sys(llm, 1)).toContain(p1!.instructions);
    expect(sys(llm, 1)).not.toContain(p0!.instructions);
    expect(agent.sessions.get(S)!.live!.promptPhases).toEqual([p0!.id, p1!.id]);
    // The context (which names the phase) is fetched again for the new phase.
    expect(transport.of('buildContext')).toHaveLength(2);
    // The rest of the history is kept: tool results are still there.
    expect(llm.calls[1]!.messages.filter(m => m.role === 'tool')).toHaveLength(2);
    expect(logs.some(l => l.includes(`phase -> ${p1!.id}`))).toBe(true);
  });

  it('a rejected set_phase keeps the current block', async () => {
    const llm = new FakeLlm([
      [tool(TOOL_NAMES.setPhase, { phase: p1!.id, reason: 'r' })],
      [...tokens('Let us stay here a little longer. What do you see?'), done],
    ]);
    const { agent, transport } = makeAgent(llm);
    transport.fail.setPhase = 'transition not allowed';
    agent.onSession(session(S, { phase: p0!.id }));
    agent.onTurn(turn(S, 0, 'hm'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    expect(sys(llm, 1)).toContain(p0!.instructions);
    expect(sys(llm, 1)).not.toContain(p1!.instructions);
  });

  it('the next reply uses the phase from the session row', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { phase: p0!.id }));
    agent.onTurn(turn(S, 0, 'one'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    agent.onSession(session(S, { phase: p1!.id }));
    agent.onTurn(turn(S, 1, 'Okay.', 'done', 'tutor'));
    agent.onTurn(turn(S, 2, 'two'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    expect(sys(llm, 0)).toContain(p0!.instructions);
    expect(sys(llm, 1)).toContain(p1!.instructions);
    expect(sys(llm, 1)).not.toContain(p0!.instructions);
  });
});
