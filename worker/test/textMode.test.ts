// Text mode: typed turns (submitTextTurn) are answered exactly like spoken ones.
import { describe, expect, it } from 'vitest';
import { done, FakeLlm, lastUser, makeAgent, session, sleep, tokens, turn, waitFor } from './fakes';

const A = 1n;

describe('text turns', () => {
  it('a ready text turn in a voice=false session is answered like a voice turn', async () => {
    const llm = new FakeLlm([[...tokens('Look at the bars. Each one is a whole.'), done]]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn({ ...turn(A, 0, 'why twelfths?'), source: 'text', intent: '' });
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    expect(transport.names(A).filter(n => n !== 'buildContext')).toEqual(['beginUtterance', 'addSentence', 'addSentence', 'appendTutorTurn']);
    expect(String(lastUser(llm.calls[0]!.messages)!.content)).toBe('why twelfths?');
  });

  it('a lesson button intent reaches the prompt with the turn', async () => {
    const llm = new FakeLlm([[...tokens('Here is another picture.'), done]]);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A, { voice: false }));
    agent.onTurn({ ...turn(A, 0, 'Can you show me another way?'), source: 'text', intent: 'another_way' });
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    expect(String(lastUser(llm.calls[0]!.messages)!.content)).toBe('Can you show me another way?\n\n[The student pressed the lesson button "another_way".]');
  });

  it('a newer typed turn interrupts the running reply (no preemptive hold for text turns)', async () => {
    let release!: () => void;
    const wait = new Promise<void>(r => (release = r));
    const llm = new FakeLlm([
      [...tokens('First sentence here. '), { type: 'wait', until: wait }, ...tokens('Never said.'), done],
      [...tokens('Answer to the second one.'), done],
    ]);
    const { agent, transport } = makeAgent(llm, undefined, { preemptive: true });
    agent.onSession(session(A, { voice: false }));
    agent.onTurn({ ...turn(A, 0, 'first'), source: 'text' });
    await waitFor(() => transport.of('addSentence', A).length === 1);
    agent.onTurn({ ...turn(A, 0, 'first', 'done'), source: 'text' });
    agent.onTurn({ ...turn(A, 1, 'second'), source: 'text' });
    await waitFor(() => transport.of('appendTutorTurn', A).length === 2);
    release();
    await sleep(5);
    const appended = transport.of('appendTutorTurn', A);
    expect(appended[0]).toMatchObject({ interrupted: true });
    expect(appended[1]).toMatchObject({ interrupted: false, text: 'Answer to the second one.' });
  });
});
