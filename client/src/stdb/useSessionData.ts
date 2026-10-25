// Narrow subscription to one session's rows (spec "Audio rules": never all tables).
import { useEffect, useMemo, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Beat, BoardItem, CanvasState, Learner, LessonState, Phrase, ReplySentence, Session, Turn, TurnMetrics } from '../module_bindings/types';
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
  /** Team lesson rows (docs/CONTRACT-night.md section 1). */
  beats: Beat[];
  lessonState: LessonState | undefined;
  canvasState: CanvasState | undefined;
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
    `SELECT * FROM beat WHERE session_id = ${id}`,
    `SELECT * FROM lesson_state WHERE session_id = ${id}`,
    `SELECT * FROM canvas_state WHERE session_id = ${id}`,
  ];
  if (withAudio) q.push(`SELECT * FROM audio_out WHERE session_id = ${id}`);
  return q;
}

/** Resubscribes before a session counts as missing (~2 s in total). */
const MISSING_RETRIES = 5;

export function useSessionData(conn: DbConnection | null, sessionId: bigint, opts: { withAudio: boolean }): SessionData {
  const [subReady, setSubReady] = useState(false);
  const [error, setError] = useState('');
  // Resubscribe attempts while the session row is missing from the cache. Right after
  // startSession the row can vanish for a moment (the previous screen's overlapping
  // subscription is torn down after this one is applied), which used to show "Session N does
  // not exist" for a session that exists. Re-applying the subscription brings it back.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setAttempt(0), [conn, sessionId]);

  useEffect(() => {
    if (!conn) return;
    setSubReady(false);
    let cancelled = false;
    const sub = subscribe(conn, sessionQueries(sessionId, opts.withAudio), `session ${sessionId}`);
    sub.ready.then(
      () => !cancelled && setSubReady(true),
      e => setError(String(e?.message ?? e))
    );
    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [conn, sessionId, opts.withAudio, attempt]);

  const db = conn?.db;
  const mine = (r: { sessionId: bigint }) => r.sessionId === sessionId;
  const sessions = useRows<Session>(db?.session, r => r.id === sessionId, [sessionId]);
  const session = sessions[0];
  const learnerId = session?.learnerId;

  const missing = subReady && !session;
  useEffect(() => {
    if (!missing || attempt >= MISSING_RETRIES) return;
    const t = setTimeout(() => setAttempt(a => a + 1), 150 * (attempt + 1));
    return () => clearTimeout(t);
  }, [missing, attempt]);
  // "ready" for the screen: the row is there, or every retry came back without it.
  const ready = subReady && (!!session || attempt >= MISSING_RETRIES);

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
  const beats = useRows<Beat>(db?.beat, mine, [sessionId]);
  const lessonStates = useRows<LessonState>(db?.lessonState, mine, [sessionId]);
  const canvasStates = useRows<CanvasState>(db?.canvasState, mine, [sessionId]);

  return useMemo(
    () => ({ ready, error, session, learner: learners[0], phrases, turns, sentences, boardItems, metrics, beats, lessonState: lessonStates[0], canvasState: canvasStates[0] }),
    [ready, error, session, learners, phrases, turns, sentences, boardItems, metrics, beats, lessonStates, canvasStates]
  );
}
