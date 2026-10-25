// Student presence (docs/CLASSROOM.md): online = waiting | in_session. A class session started by
// a teacher pulls every online student into a new linked session. Pure decisions here; the hook
// in stdb/usePresence.ts calls setPresence. Unit-tested in test/presence.test.ts.

export type PresenceStatus = 'offline' | 'waiting' | 'in_session';
export type PresenceScreen = 'waiting' | 'session' | 'none';

export interface PresenceInput {
  screen: PresenceScreen;
  /** Session screen: the session is still active. */
  sessionActive?: boolean;
  /** The page is being closed (pagehide). */
  unloading?: boolean;
}

/**
 * The status this tab should hold, or null = leave it alone.
 * - closing the page → offline (the module also does this on disconnect)
 * - waiting room → waiting
 * - an active session → in_session; an ended one is left to the module (endClassSession sets
 *   waiting, endSession leaves it)
 * Hidden tabs keep their status: a student in a background tab is still joinable; the tab
 * re-asserts its status when it becomes visible again (a reconnect may have marked it offline).
 */
export function desiredPresence(i: PresenceInput): PresenceStatus | null {
  if (i.screen === 'none') return null;
  if (i.unloading) return 'offline';
  if (i.screen === 'waiting') return 'waiting';
  return i.sessionActive ? 'in_session' : null;
}

export interface SessionLike {
  id: bigint;
  learnerId: bigint;
  active: boolean;
  classSessionId: bigint;
}

/**
 * A class session the teacher started for this learner: the newest active session linked to a
 * class (classSessionId != 0) other than the one on screen.
 */
export function classSessionToJoin<S extends SessionLike>(sessions: S[], learnerId: bigint, currentId: bigint | null = null): S | undefined {
  return sessions
    .filter(s => s.learnerId === learnerId && s.active && s.classSessionId !== 0n && s.id !== currentId && (currentId === null || s.id > currentId))
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
}

export type AfterEnd = { kind: 'join'; sessionId: bigint } | { kind: 'wait' } | { kind: 'stay' };

/**
 * What the session screen does when its session changes: a newer class session for the learner
 * → join it; the class session on screen ended (endClassSession sends students back to waiting)
 * → the waiting room; otherwise stay (an ad-hoc session the student finished).
 */
export function afterSessionChange<S extends SessionLike>(current: S | undefined, sessions: S[]): AfterEnd {
  if (!current) return { kind: 'stay' };
  const next = classSessionToJoin(sessions, current.learnerId, current.id);
  if (next) return { kind: 'join', sessionId: next.id };
  if (!current.active && current.classSessionId !== 0n) return { kind: 'wait' };
  return { kind: 'stay' };
}
