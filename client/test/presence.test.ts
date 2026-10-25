import { describe, expect, it } from 'vitest';
import { afterSessionChange, classSessionToJoin, desiredPresence, type SessionLike } from '../src/lib/presence';

const s = (id: number, learnerId: number, active: boolean, classSessionId = 0): SessionLike => ({ id: BigInt(id), learnerId: BigInt(learnerId), active, classSessionId: BigInt(classSessionId) });

describe('presence transitions', () => {
  it('waiting room → waiting, active session → in_session', () => {
    expect(desiredPresence({ screen: 'waiting' })).toBe('waiting');
    expect(desiredPresence({ screen: 'session', sessionActive: true })).toBe('in_session');
  });

  it('closing the page → offline (waiting or in a session)', () => {
    expect(desiredPresence({ screen: 'waiting', unloading: true })).toBe('offline');
    expect(desiredPresence({ screen: 'session', sessionActive: true, unloading: true })).toBe('offline');
  });

  it('leaves the status alone for ended sessions and other screens', () => {
    expect(desiredPresence({ screen: 'session', sessionActive: false })).toBeNull(); // the module sets waiting after a class
    expect(desiredPresence({ screen: 'none' })).toBeNull();
    expect(desiredPresence({ screen: 'none', unloading: true })).toBeNull();
  });
});

describe('auto-join when the teacher starts a class', () => {
  it('waiting room: finds the linked session of this learner', () => {
    const rows = [s(1, 7, false), s(2, 8, true, 3), s(4, 7, true, 3)];
    expect(classSessionToJoin(rows, 7n)?.id).toBe(4n);
    expect(classSessionToJoin(rows, 9n)).toBeUndefined();
  });

  it('ignores ad-hoc sessions and ended class sessions', () => {
    expect(classSessionToJoin([s(5, 7, true, 0), s(6, 7, false, 2)], 7n)).toBeUndefined();
  });

  it('takes the newest when several are linked', () => {
    expect(classSessionToJoin([s(10, 7, true, 1), s(12, 7, true, 2), s(11, 7, true, 1)], 7n)?.id).toBe(12n);
  });

  it('session screen: a student in an ad-hoc session moves into the new class session', () => {
    const adhoc = s(20, 7, false); // ended by startClassSession
    expect(afterSessionChange(adhoc, [adhoc, s(21, 7, true, 5)])).toEqual({ kind: 'join', sessionId: 21n });
  });

  it('session screen: never jumps back to an older session', () => {
    const cur = s(30, 7, true, 5);
    expect(afterSessionChange(cur, [s(25, 7, true, 4), cur])).toEqual({ kind: 'stay' });
  });

  it('class over → waiting room; own session over → stay', () => {
    expect(afterSessionChange(s(40, 7, false, 5), [])).toEqual({ kind: 'wait' });
    expect(afterSessionChange(s(41, 7, false, 0), [])).toEqual({ kind: 'stay' });
    expect(afterSessionChange(undefined, [])).toEqual({ kind: 'stay' });
  });
});
