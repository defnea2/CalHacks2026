// Keeps the learner's presence row in sync with the screen (see lib/presence.ts for the rules).
import { useEffect, useRef } from 'react';
import type { DbConnection } from '../module_bindings';
import { callReducer } from './connection';
import { desiredPresence, type PresenceScreen, type PresenceStatus } from '../lib/presence';

export function setPresence(conn: DbConnection, learnerId: bigint, status: PresenceStatus) {
  const args = { learnerId, status };
  return callReducer('setPresence', args, () => conn.reducers.setPresence(args), true);
}

export function usePresence(conn: DbConnection | null, learnerId: bigint | undefined, screen: PresenceScreen, sessionActive = false) {
  const last = useRef<string>('');
  useEffect(() => {
    if (!conn || learnerId === undefined) return;
    const apply = (force: boolean, unloading = false) => {
      const want = desiredPresence({ screen, sessionActive, unloading });
      if (!want) return;
      const key = `${learnerId}:${want}`;
      if (!force && last.current === key) return;
      last.current = key;
      void setPresence(conn, learnerId, want);
    };
    apply(false);
    const onVisible = () => document.visibilityState === 'visible' && apply(true);
    const onHide = () => apply(true, true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onHide);
    };
  }, [conn, learnerId, screen, sessionActive]);
}
