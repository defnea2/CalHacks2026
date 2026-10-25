// One reply end to end through the Agent: sentences, metrics, tool ordering and tool rounds.
import { describe, expect, it } from 'vitest';
import { markerReminder, pack, renderPhaseBlock, TOOL_NAMES } from '@tutor/shared';
import { done, FakeLlm, makeAgent, session, text, tokens, tool, turn, waitFor } from './fakes';

const S = 1n;
const kind = pack.boardKinds[0]!.name;
const phaseId = pack.phases[1]!.id;
const category = pack.taxonomy[0]!.key;

async function answer(llm: FakeLlm, prep?: (t: ReturnType<typeof makeAgent>['transport']) => void) {
  const m = makeAgent(llm);
  prep?.(m.transport);
  m.agent.onSession(session(S));
  m.agent.onTurn(turn(S, 0, 'I do not get how to expand fractions.'));
  await waitFor(() => m.transport.of('appendTutorTurn').length > 0, 2000, 'appendTutorTurn');
  return m;
}

describe('reply', () => {
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
      { role: 'system', content: renderPhaseBlock(pack, pack.initialPhase) },
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
        ...tokens('Is each slice the same size as the others?'),
        done,
      ],
    ]);
    const { transport } = await answer(llm);
    expect(transport.names()).toEqual(['buildContext', 'beginUtterance', 'addSentence', 'setPhase', 'addSentence', 'showBoardItem', 'addSentence', 'appendTutorTurn']);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(2);
    expect(llm.calls).toHaveLength(1); // actions, and the reply already ends with a next step: no extra LLM call
  });

  it('short first sentence + action tools without a next step: the LLM continues the same reply', async () => {
    const llm = new FakeLlm([
      [...tokens('Okay, let us draw it together. '), tool(TOOL_NAMES.showBoardItem, { kind, content: { text: 'pizza' } }, 'b1'), done],
      [...tokens('Here is a pizza cut into three slices. How many slices are shaded?'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'b1' });
    expect(transport.of('addSentence').map(x => x.display)).toEqual([
      'Okay, let us draw it together.',
      'Here is a pizza cut into three slices.',
      'How many slices are shaded?',
    ]);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(1);
    expect(transport.of('appendTutorTurn')[0]!.text).toBe('Okay, let us draw it together. Here is a pizza cut into three slices. How many slices are shaded?');
  });

  it('board item before any text points at sentence 0', async () => {
    const llm = new FakeLlm([[tool(TOOL_NAMES.showBoardItem, { kind, content: { text: 'a' } }), ...tokens('Here is a picture of our pizza for you.'), done]]);
    const { transport } = await answer(llm);
    expect(transport.of('showBoardItem')[0]!.sentenceIdx).toBe(0);
  });

  it('action-only reply without text calls the LLM again with the results', async () => {
    const llm = new FakeLlm([
      [tool(TOOL_NAMES.setPhase, { phase: phaseId, reason: 'r' }, 'p1'), tool(TOOL_NAMES.clearBoard, {}, 'c1'), done],
      [...tokens('Now let us look at this picture together.'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    const second = llm.calls[1]!.messages;
    const tail = second.slice(-4);
    expect(tail[0]).toMatchObject({ role: 'assistant', content: '', toolCalls: [{ id: 'p1' }, { id: 'c1' }] });
    expect(tail[1]).toMatchObject({ role: 'tool', toolCallId: 'p1', content: 'ok' });
    expect(tail[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'ok' });
    // set_phase succeeded: the new phase block follows the tool results.
    expect(tail[3]).toEqual({ role: 'system', content: renderPhaseBlock(pack, phaseId, true) });
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
    // The result carries the inline-marker reminder (the next round may show board items).
    expect(llm.calls[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 't1',
      name: TOOL_NAMES.setTopic,
      content: `${transport.topicResult}\n\n${markerReminder(TOOL_NAMES.showBoardItem)}`,
    });
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

describe('inline board markers', () => {
  const board = (id: string | undefined, label: string) => tool(TOOL_NAMES.showBoardItem, { ...(id ? { id } : {}), kind, content: { text: label } });
  const anchors = (t: ReturnType<typeof makeAgent>['transport']) =>
    t.of('showBoardItem').map(a => [JSON.parse(a.content as string).text, a.sentenceIdx, a.markerPos]);
  const sentences = (t: ReturnType<typeof makeAgent>['transport']) => t.of('addSentence') as { display: string; speech: string }[];

  it('strips markers, anchors items at their word; tools after the text; missing marker / missing tool', async () => {
    const llm = new FakeLlm([
      [
        ...tokens('Here are two thirds ⟦b1⟧, and here are eight twelfths ⟦b2⟧. Which one covers more of the bar? ⟦b3⟧ ⟦orphan⟧'),
        board('b1', 'one'),
        board('b2', 'two'),
        board('b3', 'three'),
        board('b4', 'no marker'),
        board(undefined, 'no id'),
        done,
      ],
    ]);
    const { transport } = await answer(llm);
    const sent = sentences(transport);
    expect(sent.map(x => x.display)).toEqual(['Here are two thirds, and here are eight twelfths.', 'Which one covers more of the bar?']);
    expect(sent.every(x => !/[⟦⟧]/.test(x.speech + x.display))).toBe(true);
    const s0 = sent[0]!.speech;
    expect(anchors(transport)).toEqual([
      ['one', 0, s0.indexOf(', and')],
      ['two', 0, s0.length - 1],
      ['three', 1, sent[1]!.speech.length], // marker after the last "?" -> end of that sentence
      ['no marker', 2, -1], // keeps the default: the sentence that was next when the call ran
      ['no id', 2, -1],
    ]);
    expect(transport.of('appendTutorTurn')[0]!.text).toBe('Here are two thirds, and here are eight twelfths. Which one covers more of the bar?');
    // "...? ⟦b3⟧ ⟦orphan⟧" ends with a next step once the markers are stripped: no extra round.
    expect(llm.calls).toHaveLength(1);
  });

  it('a call that arrives before its marker waits for the text (order kept)', async () => {
    const llm = new FakeLlm([
      [
        board('b1', 'early'),
        tool(TOOL_NAMES.clearBoard, {}),
        ...tokens('Can you see this picture ⟦b1⟧ of a pizza here?'),
        done,
      ],
    ]);
    const { transport } = await answer(llm);
    const names = transport.names().filter(n => n !== 'recordMetric');
    expect(names).toEqual(['buildContext', 'beginUtterance', 'addSentence', 'showBoardItem', 'clearBoard', 'appendTutorTurn']);
    const sp = sentences(transport)[0]!.speech;
    expect(anchors(transport)).toEqual([['early', 0, sp.indexOf('of a pizza')]]);
    expect(llm.calls).toHaveLength(1); // ends with a next step: no extra round
  });

  it('a marker spoken in one round anchors the item of the next round (after a query)', async () => {
    const llm = new FakeLlm([
      [...tokens('Okay, here is two thirds ⟦b1⟧ on our board. '), tool(TOOL_NAMES.setTopic, { category }, 't1'), done],
      [...tokens('Do the shaded parts look the same?'), board('b1', 'later'), done],
    ]);
    const { transport } = await answer(llm);
    expect(llm.calls).toHaveLength(2);
    const sp = sentences(transport)[0]!.speech;
    expect(anchors(transport)).toEqual([['later', 0, sp.indexOf('on our board')]]);
    // The model sees its own markers in the history of this reply.
    expect(llm.calls[1]!.messages.find(m => m.role === 'assistant')!.content).toContain('⟦b1⟧');
  });

  it('a reused id maps to the next unconsumed marker', async () => {
    const llm = new FakeLlm([
      [...tokens('First this one ⟦b1⟧ and then this one ⟦b1⟧ right here, see?'), board('b1', 'x'), board('B1', 'y'), board('b1', 'z'), done],
    ]);
    const { transport } = await answer(llm);
    const sp = sentences(transport)[0]!.speech;
    expect(anchors(transport)).toEqual([
      ['x', 0, sp.indexOf('and then')],
      ['y', 0, sp.indexOf('right here')],
      ['z', 1, -1],
    ]);
  });
});
