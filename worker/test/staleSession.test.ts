// Stale per-session state: after a reconnect or `--clear` (session ids restart at 1) a reused
// SessionAgent held old turns/utterances and the tutor stayed silent.
import { describe, expect, it } from 'vitest';
import { done, FakeLlm, makeAgent, session, tokens, turn, waitFor } from './fakes';

const A = 1n;
const reply = () => [...tokens('Okay, let us look at it.'), done];

describe('stale per-session state (reconnect, cleared database)', () => {
  it('closeAll (done on every (re)connect) lets a new session with the same id get a reply', async () => {
    const llm = new FakeLlm(reply);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'hello'));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    agent.onTurn(turn(A, 1, 'Okay, let us look at it.', 'done', 'tutor'));
    // `--clear` + republish: session 1 is a new session, its first turn is idx 0 again.
    agent.closeAll();
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'two thirds'));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 2);
    expect(llm.calls).toHaveLength(2);
  });

  it('a session row with a different startedAt replaces the old SessionAgent', async () => {
    const llm = new FakeLlm(reply);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A, { startedAt: { microsSinceUnixEpoch: 1n } }));
    agent.onTurn(turn(A, 0, 'hello'));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
    agent.onTurn(turn(A, 1, 'Okay, let us look at it.', 'done', 'tutor'));
    const old = agent.sessions.get(A)!;
    agent.onSession(session(A, { startedAt: { microsSinceUnixEpoch: 2n } }));
    expect(agent.sessions.get(A)).not.toBe(old);
    agent.onTurn(turn(A, 0, 'two thirds'));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 2);
    // A re-delivered row (same startedAt) keeps the agent.
    const cur = agent.sessions.get(A)!;
    agent.onSession(session(A, { startedAt: { microsSinceUnixEpoch: 2n } }));
    expect(agent.sessions.get(A)).toBe(cur);
  });
});

describe('ended or unknown sessions (table-wide turn/phrase/sentence subscriptions)', () => {
  it('rows of an ended session create no SessionAgent and get no reply', async () => {
    const llm = new FakeLlm(reply);
    const { agent, transport } = makeAgent(llm);
    agent.onSession(session(A));
    expect(agent.sessions.has(A)).toBe(true);
    agent.onSession(session(A, { active: false }));
    expect(agent.sessions.has(A)).toBe(false);
    // closeLiveTurns updates the old turns in the same transaction; old rows may be re-delivered.
    agent.onTurn(turn(A, 0, 'hello'));
    agent.onSentence({ id: 1n, sessionId: A, utteranceId: 5n, idx: 0, display: 'x', speech: 'x', status: 'dropped' } as never);
    expect(agent.sessions.has(A)).toBe(false);
    await new Promise(r => setTimeout(r, 30));
    expect(llm.calls).toHaveLength(0);
    expect(transport.of('beginUtterance', A)).toHaveLength(0);
    // The same id becoming active again (cleared database) is served.
    agent.onSession(session(A));
    agent.onTurn(turn(A, 0, 'hello'));
    await waitFor(() => transport.of('appendTutorTurn', A).length === 1);
  });

  it('rows of a session the active-session cache does not hold are ignored', () => {
    const { agent } = makeAgent(new FakeLlm(reply));
    agent.isActiveSession = id => id === A;
    agent.onTurn(turn(7n, 0, 'old history'));
    expect(agent.sessions.has(7n)).toBe(false);
    agent.onTurn(turn(A, 0, 'hello'));
    expect(agent.sessions.has(A)).toBe(true);
  });
});
