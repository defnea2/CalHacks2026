// The tutor speaks first (opening reply) and the phase block (current phase instructions).
import { describe, expect, it } from 'vitest';
import { OPENING_TURN_IDX, pack, renderPhaseBlock, TOOL_NAMES } from '@tutor/shared';
import { done, FakeLlm, makeAgent, phrase, session, sleep, tokens, tool, turn, waitFor, lastUser } from './fakes';

const S = 1n;
const category = pack.taxonomy[0]!.key;
const [p0, p1, p2] = pack.phases;

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
    expect(lastUser(msgs)).toEqual({ role: 'user', content: pack.prompts.opening });
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
    expect(lastUser(llm.calls[0]!.messages)).toEqual({ role: 'user', content: 'Can you help me?' });
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

describe('phase instructions (append-only phase block, stable system prompt)', () => {
  const phaseMsgs = (llm: FakeLlm, i: number) =>
    llm.calls[i]!.messages.filter(m => m.role === 'system' && pack.phases.some(p => String(m.content).includes(p.instructions))).map(m => String(m.content));
  const noInstructions = (s: string) => pack.phases.every(p => !s.includes(p.instructions));

  it('the current phase block (from the session row) follows the current turn; the system prompt has no phase instructions', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { phase: p2!.id }));
    agent.onTurn(turn(S, 0, 'ok'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    const msgs = llm.calls[0]!.messages;
    expect(noInstructions(String(msgs[0]!.content))).toBe(true);
    expect(msgs[0]!.content).not.toMatch(/\{\{\w+\}\}/);
    expect(msgs.at(-2)).toEqual({ role: 'user', content: 'ok' });
    expect(msgs.at(-1)).toEqual({ role: 'system', content: renderPhaseBlock(pack, p2!.id) });
    expect(phaseMsgs(llm, 0)).toHaveLength(1);
    for (const p of pack.phases) if (p.id !== p2!.id) expect(String(msgs.at(-1)!.content)).not.toContain(p.instructions);
  });

  it('a successful set_phase appends the new block after the tool results; earlier messages stay byte-identical', async () => {
    const llm = new FakeLlm([
      [...tokens('Fractions, nice, let us look closer. '), tool(TOOL_NAMES.setTopic, { category }), tool(TOOL_NAMES.setPhase, { phase: p1!.id, reason: 'found the gap' }), done],
      [...tokens('Picture a pizza cut into three slices. How many slices do you get?'), done],
    ]);
    const { agent, transport, logs } = makeAgent(llm);
    agent.onSession(session(S, { phase: p0!.id }));
    agent.onTurn(turn(S, 0, 'I do not get fractions.'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(llm.calls).toHaveLength(2);
    const [r1, r2] = [llm.calls[0]!.messages, llm.calls[1]!.messages];
    // Append-only: round 2 starts with exactly round 1's messages (system prompt unchanged).
    expect(r2.slice(0, r1.length)).toEqual(r1);
    expect(r2[0]).toEqual(r1[0]);
    // Then assistant + 2 tool results + the new phase block (the subscription has NOT delivered the phase yet).
    expect(r2.slice(r1.length).map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'system']);
    expect(r2.at(-1)).toEqual({ role: 'system', content: renderPhaseBlock(pack, p1!.id, true) });
    expect(String(r2.at(-1)!.content)).not.toContain(p0!.instructions);
    expect(agent.sessions.get(S)!.live!.promptPhases).toEqual([p0!.id, p1!.id]);
    expect(transport.of('buildContext')).toHaveLength(1);
    expect(logs.some(l => l.includes(`phase -> ${p1!.id}`))).toBe(true);
  });

  it('a rejected set_phase appends nothing', async () => {
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
    expect(phaseMsgs(llm, 1)).toEqual([renderPhaseBlock(pack, p0!.id)]);
    expect(llm.calls[1]!.messages.at(-1)!.role).toBe('tool');
  });

  it('the next reply only has the current phase block', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { phase: p0!.id }));
    agent.onTurn(turn(S, 0, 'one'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    agent.onSession(session(S, { phase: p1!.id }));
    agent.onTurn(turn(S, 1, 'Okay.', 'done', 'tutor'));
    agent.onTurn(turn(S, 2, 'two'));
    await waitFor(() => transport.of('appendTutorTurn').length === 2);
    expect(phaseMsgs(llm, 0)).toEqual([renderPhaseBlock(pack, p0!.id)]);
    expect(phaseMsgs(llm, 1)).toEqual([renderPhaseBlock(pack, p1!.id)]);
    expect(llm.calls[1]!.messages[0]).toEqual(llm.calls[0]!.messages[0]);
  });

  it('the opening also gets the phase block after its instruction', async () => {
    const llm = new FakeLlm([]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(S, { turnState: 'thinking' }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    const msgs = llm.calls[0]!.messages;
    expect(msgs.slice(-2)).toEqual([
      { role: 'user', content: pack.prompts.opening },
      { role: 'system', content: renderPhaseBlock(pack, pack.initialPhase) },
    ]);
  });
});
