// A rejected run promise or any stray rejection is logged, never crashes the worker.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unhandledRejectionLogger } from '../src/agent';
import { ReplyRun } from '../src/reply';
import { FakeLlm, done, makeAgent, session, sleep, tokens, turn } from './fakes';

afterEach(() => vi.restoreAllMocks());

describe('crash guards', () => {
  it('unhandledRejectionLogger logs the reason instead of throwing', () => {
    const logs: string[] = [];
    const h = unhandledRejectionLogger(m => logs.push(m));
    expect(() => h(new Error('socket closed'))).not.toThrow();
    h('plain reason');
    expect(logs[0]).toMatch(/unhandled rejection: .*socket closed/);
    expect(logs[1]).toBe('worker: unhandled rejection: plain reason');
  });

  it('a run whose done promise rejects is caught and logged (no unhandled rejection)', async () => {
    vi.spyOn(ReplyRun.prototype as unknown as { main: () => Promise<void> }, 'main').mockImplementation(() => Promise.reject(new Error('boom')));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { agent, logs } = makeAgent(new FakeLlm(() => [...tokens('Hi.'), done]));
      agent.onSession(session(1n));
      agent.onTurn(turn(1n, 0, 'hello'));
      await sleep(20);
      expect(logs.some(l => /run u\d+ failed: boom/.test(l))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
