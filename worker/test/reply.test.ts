// One reply end to end through the Agent: sentences, metrics, tool ordering and tool rounds.
import { describe, expect, it } from 'vitest';
import { pack, TOOL_NAMES } from '@tutor/shared';
import { done, FakeLlm, makeAgent, phrase, session, sleep, text, tokens, tool, turn, waitFor } from './fakes';

const S = 1n;
const kind = pack.boardKinds.find(k => k.name === 'text')!.name;
const phaseId = pack.phases[1]!.id;
const category = pack.taxonomy[0]!.key;
const narratedCanvas = { title: 'Same amount, smaller pieces', moments: [
  { sentenceOffset: 0, narration: 'Half the bar is shaded.', visual: { kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 2, shaded: 1 }] } },
  { sentenceOffset: 1, narration: 'Now each half is split in two. Did the shaded length change?', visual: { kind: 'update', changes: [{ type: 'set_bar', barId: 'a', parts: 4, shaded: 2 }] } },
] };

async function answer(llm: FakeLlm, prep?: (t: ReturnType<typeof makeAgent>['transport']) => void) {
  const m = makeAgent(llm);
  prep?.(m.transport);
  m.agent.onSession(session(S));
  m.agent.onTurn(turn(S, 0, 'I do not get how to expand fractions.'));
  await waitFor(() => m.transport.of('appendTutorTurn').length > 0, 2000, 'appendTutorTurn');
  return m;
}

describe('reply', () => {
  it('delivers paired narration once, keeps its cues intact, and skips redundant model rounds', async () => {
    const llm = new FakeLlm([[
      tool(TOOL_NAMES.setTopic, { category }),
      tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }),
      text('Half the bar is shaded. Now each half is split in two. Did the shaded length change?'), done,
    ]]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(1);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(0);
    expect(transport.of('addSentence').map(s => [s.idx, s.display])).toEqual(narratedCanvas.moments.map(m => [m.sentenceOffset, m.narration]));
    expect(transport.of('appendTutorTurn')[0]!.text).toBe(narratedCanvas.moments.map(m => m.narration).join(' '));
  });

  it('preserves a preamble index but will not publish a second narrated canvas in the same reply', async () => {
    const llm = new FakeLlm([[
      text('Watch the shaded length. '),
      tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }),
      tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }), done,
    ]]);
    const { transport } = await answer(llm);
    expect(transport.of('showBoardItem')).toHaveLength(1);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(1);
    expect(transport.of('addSentence').map(s => s.idx)).toEqual([0, 1, 2]);
    expect(llm.calls).toHaveLength(1);
  });

  it('rejects a partially narrated plan before any picture or speech, then repairs it', async () => {
    const invalid = structuredClone(narratedCanvas);
    invalid.moments[1]!.narration = '';
    const llm = new FakeLlm([
      [tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: invalid }), done],
      [tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    expect(transport.of('showBoardItem')).toHaveLength(1);
    expect(transport.of('addSentence').map(s => s.display)).toEqual(narratedCanvas.moments.map(m => m.narration));
  });

  it('keeps both paired narration and visuals behind the preemptive gate', async () => {
    const llm = new FakeLlm([[tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }), done]]);
    const { agent, transport } = makeAgent(llm, undefined, { preemptive: true, preemptiveSilenceMs: 1 });
    agent.onSession(session(S));
    agent.onPhrase(phrase(S, 1, 0, 'done', 'Why two quarters?'));
    agent.onTurn(turn(S, 0, 'Why two quarters?', 'open'));
    await waitFor(() => llm.calls.length === 1);
    await sleep(20);
    expect(transport.names()).toEqual(['buildContext']);
    agent.onTurn(turn(S, 0, 'Why two quarters?', 'ready'));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('showBoardItem')).toHaveLength(1);
    expect(transport.of('addSentence')).toHaveLength(2);
  });

  it('stops the remaining planned narration after interruption', async () => {
    const llm = new FakeLlm([[tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: narratedCanvas }), done]]);
    const { agent, transport } = makeAgent(llm);
    transport.delayMs.addSentence = 50;
    agent.onSession(session(S));
    agent.onTurn(turn(S, 0, 'Why two quarters?'));
    await waitFor(() => transport.of('addSentence').length === 1);
    agent.onSession(session(S, { turnState: 'interrupted' }));
    await waitFor(() => transport.of('appendTutorTurn').length === 1);
    expect(transport.of('addSentence')).toHaveLength(1);
    expect(transport.of('appendTutorTurn')[0]!.interrupted).toBe(true);
  });

  it('narrates all canvas moments after a spoken preamble and board tool call', async () => {
    const content = { title: 'Move the triangle', moments: [
      { sentenceOffset: 0, visual: { kind: 'parallelogram', base: 6, height: 4, shear: 2, stage: 'slant' } },
      { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_parallelogram', stage: 'cut' }] } },
      { sentenceOffset: 2, visual: { kind: 'update', changes: [{ type: 'set_parallelogram', stage: 'reassembled' }] } },
    ] };
    const llm = new FakeLlm([
      [text('Let us move the pieces. '), tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content }), done],
      [text('Here is our slanted shape. Cut the triangle from the left. Slide it to the right.'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(1);
    expect(transport.of('addSentence').map(s => s.idx)).toEqual([0, 1, 2, 3]);
    expect(transport.of('appendTutorTurn')[0]!.text).toContain('Slide it to the right.');
  });

  it('streams sentences, normalizes speech, appends the tutor turn and records metrics', async () => {
    const llm = new FakeLlm([[...tokens('Let us look at 3/4 of a pizza together. It is 3.5 times bigger than you think!'), done]]);
    const { transport, agent } = await answer(llm);
    const u = agent.sessions.get(S)!.live!.utteranceId;
    expect(transport.names()).toEqual(['buildContext', 'beginUtterance', 'addSentence', 'addSentence', 'appendTutorTurn']);
    expect(transport.of('beginUtterance')[0]).toEqual({ sessionId: S, utteranceId: u, replyToIdx: 0, preemptive: false });
    expect(transport.of('addSentence')).toEqual([
      { sessionId: S, utteranceId: u, idx: 0, display: 'Let us look at 3/4 of a pizza together.', speech: 'Let us look at three quarters of a pizza together.' },
      { sessionId: S, utteranceId: u, idx: 1, display: 'It is 3.5 times bigger than you think!', speech: 'It is three point five times bigger than you think!' },
    ]);
    expect(transport.of('appendTutorTurn')[0]).toEqual({
      sessionId: S,
      utteranceId: u,
      text: 'Let us look at 3/4 of a pizza together. It is 3.5 times bigger than you think!',
      interrupted: false,
    });
    const metrics = transport.of('recordMetric').map(m => m.name);
    expect(metrics.sort()).toEqual(['firstSentenceAt', 'llmFirstTokenAt']);
    expect(transport.of('recordMetric').every(m => m.turnIdx === 0 && typeof m.atMicros === 'bigint')).toBe(true);
  });

  it('builds the prompt: system from the pack, context, recent turns, current turn', async () => {
    const llm = new FakeLlm([[...tokens('Okay, let us think about it together now.'), done]]);
    const m = makeAgent(llm);
    m.agent.onSession(session(S));
    m.agent.onTurn({ ...turn(S, 0, 'Hi there.', 'done') });
    m.agent.onTurn({ ...turn(S, 1, 'Hello! What are you working on?', 'done', 'tutor') });
    m.agent.onTurn(turn(S, 2, 'Fractions.'));
    await waitFor(() => llm.calls.length === 1);
    const msgs = llm.calls[0]!.messages;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain(pack.phases[0]!.id);
    expect(msgs[0]!.content).toContain(TOOL_NAMES.showBoardItem);
    expect(msgs[0]!.content).not.toMatch(/\{\{\w+\}\}/);
    expect(msgs[1]).toEqual({ role: 'system', content: m.transport.context });
    expect(msgs.slice(2)).toEqual([
      { role: 'user', content: 'Hi there.' },
      { role: 'assistant', content: 'Hello! What are you working on?' },
      { role: 'user', content: 'Fractions.' },
    ]);
    expect(llm.calls[0]!.tools.map(t => t.name)).toContain(TOOL_NAMES.setTopic);
  });

  it('adds the task photo on the first call only', async () => {
    const llm = new FakeLlm([]);
    const m = makeAgent(llm);
    m.transport.image = 'data:image/jpeg;base64,AAAA';
    m.agent.onSession(session(S, { hasImage: true }));
    m.agent.onTurn(turn(S, 0, 'Look at my homework.'));
    await waitFor(() => m.transport.of('appendTutorTurn').length === 1);
    m.agent.onTurn(turn(S, 1, 'Okay, I am ready to continue with it.', 'done', 'tutor'));
    m.agent.onTurn(turn(S, 2, 'What now?'));
    await waitFor(() => m.transport.of('appendTutorTurn').length === 2);
    const img = (i: number) => llm.calls[i]!.messages.some(x => Array.isArray(x.content) && x.content.some(p => p.type === 'image_url'));
    expect(img(0)).toBe(true);
    expect(img(1)).toBe(false);
    expect(m.transport.of('getSessionImage')).toHaveLength(1);
  });

  it('applies tool calls in order, tagging board items with the next sentence index', async () => {
    const llm = new FakeLlm([
      [
        ...tokens('First we cut the pizza into equal slices. '),
        tool(TOOL_NAMES.setPhase, { phase: phaseId, reason: 'found the gap' }),
        ...tokens('Look at the board with me for a second. '),
        tool(TOOL_NAMES.showBoardItem, { kind, content: { text: 'pizza' } }),
        ...tokens('Each slice is the same size as the others.'),
        done,
      ],
      [done],
    ]);
    const { transport } = await answer(llm);
    expect(transport.names()).toEqual(['buildContext', 'beginUtterance', 'addSentence', 'setPhase', 'addSentence', 'showBoardItem', 'addSentence', 'appendTutorTurn']);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(2);
    expect(llm.calls).toHaveLength(2); // board result returns so its narration can follow
  });

  it('board item before any text points at sentence 0', async () => {
    const llm = new FakeLlm([[tool(TOOL_NAMES.showBoardItem, { kind, content: { text: 'a' } }), ...tokens('Here is a picture of our pizza for you.'), done]]);
    const { transport } = await answer(llm);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(0);
  });

  it('repairs an invalid continuation after topic lookup before narrating it', async () => {
    const llm = new FakeLlm([
      [text('Let us look at the picture. '), tool(TOOL_NAMES.setTopic, { category }), done],
      [tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: { title: 'Cut', moments: [
        { sentenceOffset: 1, visual: { kind: 'update', changes: [{ type: 'set_parallelogram', stage: 'cut' }] } },
      ] } }), done],
      [tool(TOOL_NAMES.showBoardItem, { kind: 'math_canvas', content: { title: 'Cut', moments: [
        { sentenceOffset: 0, visual: { kind: 'parallelogram', base: 6, height: 4, shear: 2, stage: 'cut' } },
      ] } }), done],
      [text('Cut the triangle here.'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls.map(c => c.tools.length > 0)).toEqual([true, true, true, false]);
    expect(transport.of('showBoardItem')).toHaveLength(1);
    expect(transport.of('addSentence').map(s => s.display)).toEqual(['Let us look at the picture.', 'Cut the triangle here.']);
  });

  it('action-only reply without text calls the LLM again with the results', async () => {
    const llm = new FakeLlm([
      [tool(TOOL_NAMES.setPhase, { phase: phaseId, reason: 'r' }, 'p1'), tool(TOOL_NAMES.clearBoard, {}, 'c1'), done],
      [...tokens('Now let us look at this picture together.'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    const second = llm.calls[1]!.messages;
    const tail = second.slice(-3);
    expect(tail[0]).toMatchObject({ role: 'assistant', content: '', toolCalls: [{ id: 'p1' }, { id: 'c1' }] });
    expect(tail[1]).toMatchObject({ role: 'tool', toolCallId: 'p1', content: 'ok' });
    expect(tail[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'ok' });
    expect(transport.of('addSentence')).toHaveLength(1);
  });

  it('errors come back as tool results, not exceptions', async () => {
    const llm = new FakeLlm([[tool(TOOL_NAMES.setPhase, { phase: phaseId, reason: 'r' }, 'p1'), done], [...tokens('Let us stay here a little bit longer then.'), done]]);
    const { transport } = await answer(llm, t => (t.fail.setPhase = 'invalid transition'));
    expect(llm.calls[1]!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'p1', content: 'error: invalid transition' });
    expect(transport.of('appendTutorTurn')[0]!.interrupted).toBe(false);
  });

  it('query tool triggers another round with the result', async () => {
    const llm = new FakeLlm([
      [...tokens('Okay, fractions it is, my friend. '), tool(TOOL_NAMES.setTopic, { category }, 't1'), done],
      [...tokens('A fraction is a part of a whole thing.'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 't1', name: TOOL_NAMES.setTopic, content: transport.topicResult });
    expect(llm.calls[1]!.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'Okay, fractions it is, my friend. ' });
    expect(transport.of('addSentence').map(a => a.idx)).toEqual([0, 1]);
    expect(transport.of('appendTutorTurn')[0]!.text).toBe('Okay, fractions it is, my friend. A fraction is a part of a whole thing.');
  });

  it('stops after MAX_TOOL_ROUNDS extra rounds', async () => {
    const llm = new FakeLlm(() => [tool(TOOL_NAMES.setTopic, { category }), done]);
    const { transport, logs } = await answer(llm);
    expect(llm.calls).toHaveLength(3); // first call + 2 tool rounds
    expect(llm.calls.map(c => c.tools.length > 0)).toEqual([true, true, false]); // last round must speak
    expect(transport.of('setTopic')).toHaveLength(3);
    expect(logs.some(l => l.includes('max tool rounds'))).toBe(true);
  });

  it('an LLM error closes the turn with what was said', async () => {
    const llm = {
      calls: 0,
      async *stream() {
        yield text('We start with the pizza and its slices today. ');
        yield text('Then ');
        throw new Error('upstream 500');
      },
    };
    const m = makeAgent(llm);
    m.agent.onSession(session(S));
    m.agent.onTurn(turn(S, 0, 'Help'));
    await waitFor(() => m.transport.of('appendTutorTurn').length > 0);
    expect(m.transport.of('appendTutorTurn')[0]).toMatchObject({ text: 'We start with the pizza and its slices today.', interrupted: false });
    expect(m.logs.some(l => l.includes('upstream 500'))).toBe(true);
  });

  it('retries a round that fails before any output (flaky network), then speaks', async () => {
    let calls = 0;
    const real = new FakeLlm([[...tokens('Good thinking, let us look at the bottom number.'), done]]);
    const flaky = new FakeLlm([]);
    flaky.stream = async function* (o) {
      calls++;
      if (calls === 1) throw new Error('Connection error.');
      yield* real.stream(o);
    };
    const { transport, logs } = await answer(flaky);
    expect(calls).toBe(2);
    expect(transport.of('addSentence').map(s => s.display)).toEqual(['Good thinking, let us look at the bottom number.']);
    expect(logs.some(l => l.includes('retry 1'))).toBe(true);
  });

  it('does not retry once output has started', async () => {
    const real = new FakeLlm([[...tokens('This is the first full sentence here.'), done]]);
    let calls = 0;
    const llm = new FakeLlm([[]]);
    llm.stream = async function* (o) {
      calls++;
      for await (const ev of real.stream(o)) {
        yield ev;
        throw new Error('Connection error.');
      }
    };
    const { transport } = await answer(llm);
    expect(calls).toBe(1);
    expect(transport.of('appendTutorTurn').length).toBe(1);
  });
});

