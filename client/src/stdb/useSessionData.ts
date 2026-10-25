// Narrow subscription to one session's rows (spec "Audio rules": never all tables).
import { useEffect, useMemo, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { BoardItem, Learner, Phrase, ReplySentence, Session, Turn, TurnMetrics } from '../module_bindings/types';
import { subscribe } from './connection';
import { useRows } from './useRows';

export interface SessionData {
  ready: boolean;
  error: string;
  session: Session | undefined;
  learner: Learner | undefined;
  phrases: Phrase[];
  turns: Turn[];
  sentences: ReplySentence[];
  boardItems: BoardItem[];
  metrics: TurnMetrics[];
}

/** Session-scoped SQL. Column names are the generated snake_case names. */
export function sessionQueries(sessionId: bigint, withAudio: boolean): string[] {
  const id = sessionId.toString();
  const q = [
    `SELECT * FROM session WHERE id = ${id}`,
    `SELECT * FROM phrase WHERE session_id = ${id}`,
    `SELECT * FROM turn WHERE session_id = ${id}`,
    `SELECT * FROM reply_sentence WHERE session_id = ${id}`,
    `SELECT * FROM board_item WHERE session_id = ${id}`,
    `SELECT * FROM turn_metrics WHERE session_id = ${id}`,
    `SELECT * FROM playback_flush WHERE session_id = ${id}`,
  ];
  if (withAudio) q.push(`SELECT * FROM audio_out WHERE session_id = ${id}`);
  return q;
}

/** Resubscribes before a session counts as missing (~2 s in total). */
const MISSING_RETRIES = 5;

export function useSessionData(conn: DbConnection | null, sessionId: bigint, opts: { withAudio: boolean }): SessionData {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  // Resubscribe attempts while the applied subscription lacks the session row. Right after
  // startSession the row can be missing from the cache for a moment (the previous screen's
  // overlapping subscription is torn down as this one is applied; unconfirmed reads), which used
  // to show "Session N does not exist" for a session that exists.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setAttempt(0), [conn, sessionId]);

  useEffect(() => {
    if (!conn) return;
    setReady(false);
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sub = subscribe(conn, sessionQueries(sessionId, opts.withAudio), `session ${sessionId}`);
    sub.ready.then(
      () => {
        if (cancelled) return;
        const found = [...conn.db.session.iter()].some(r => r.id === sessionId);
        if (found || attempt >= MISSING_RETRIES) setReady(true);
        else retry = setTimeout(() => !cancelled && setAttempt(a => a + 1), 150 * (attempt + 1));
      },
      e => setError(String(e?.message ?? e))
    );
    return () => {
      cancelled = true;
      clearTimeout(retry);
      sub.unsubscribe();
    };
  }, [conn, sessionId, opts.withAudio, attempt]);

  const db = conn?.db;
  const mine = (r: { sessionId: bigint }) => r.sessionId === sessionId;
  const sessions = useRows<Session>(db?.session, r => r.id === sessionId, [sessionId]);
  const session = sessions[0];
  const learnerId = session?.learnerId;

  useEffect(() => {
    if (!conn || learnerId === undefined) return;
    const sub = subscribe(conn, [`SELECT * FROM learner WHERE id = ${learnerId.toString()}`], `learner ${learnerId}`);
    return () => sub.unsubscribe();
  }, [conn, learnerId]);

  const learners = useRows<Learner>(db?.learner, r => r.id === learnerId, [learnerId]);
  const phrases = useRows<Phrase>(db?.phrase, mine, [sessionId]);
  const turns = useRows<Turn>(db?.turn, mine, [sessionId]);
  const sentences = useRows<ReplySentence>(db?.replySentence, mine, [sessionId]);
  const boardItems = useRows<BoardItem>(db?.boardItem, mine, [sessionId]);
  const metrics = useRows<TurnMetrics>(db?.turnMetrics, mine, [sessionId]);

  return useMemo(
    () => ({ ready, error, session, learner: learners[0], phrases, turns, sentences, boardItems, metrics }),
    [ready, error, session, learners, phrases, turns, sentences, boardItems, metrics]
  );
}
