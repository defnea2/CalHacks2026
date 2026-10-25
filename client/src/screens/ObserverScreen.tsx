// Screen 3: read-only mirror of a session (?observe=<id>). Plays nothing; tutor captions and
// board reveals follow reply_sentence status `played` (set by the session tab's markPlayed).
import { useCallback, useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ReplySentence } from '../module_bindings/types';
import { useSessionData } from '../stdb/useSessionData';
import { Board } from '../board/Board';
import { Captions, DebugPanel, Indicators, SessionTitle, useUtteranceState } from '../components/session';
import { Card, CardHeader, ErrorNote } from '../components/ui';
import { eventLog } from '../lib/debug';

const PLAYED = 'played';
const EMPTY = new Map<string, number[]>();

export function ObserverScreen({ conn, sessionId }: { conn: DbConnection; sessionId: bigint }) {
  const data = useSessionData(conn, sessionId, { withAudio: false });
  const { progress, serverOver } = useUtteranceState(data, EMPTY);
  const [flushes, setFlushes] = useState(0);

  useEffect(() => {
    const on = (_c: unknown, row: { sessionId: bigint; utteranceId: bigint }) => {
      if (row.sessionId !== sessionId) return;
      eventLog.log('observer.flush', { utteranceId: row.utteranceId.toString() });
      setFlushes(n => n + 1);
    };
    conn.db.playbackFlush.onInsert(on);
    return () => conn.db.playbackFlush.removeOnInsert(on);
  }, [conn, sessionId]);

  useEffect(() => {
    const st = window.__tutor.state;
    st.observing = sessionId.toString();
    st.sessionReady = data.ready;
    st.phase = data.session?.phase ?? '';
    st.turnState = data.session?.turnState ?? '';
    st.boardItems = data.boardItems.map(b => ({ id: b.id.toString(), idx: b.idx, kind: b.kind, visible: b.visible }));
    st.flushes = flushes;
  }, [sessionId, data, flushes]);

  const tutorShown = useCallback((s: ReplySentence) => s.status === PLAYED, []);

  if (data.error) return <ErrorNote>Subscription failed: {data.error}</ErrorNote>;
  if (data.ready && !data.session) return <p className="py-16 text-center text-sm text-muted-foreground">Session {sessionId.toString()} does not exist.</p>;

  return (
    <div data-testid="observer-screen" data-session-id={sessionId.toString()} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <SessionTitle data={data} suffix="Observer · read-only" />
        <Indicators data={data} />
        {data.session?.taskText ? <p className="text-sm text-muted-foreground">Task: {data.session.taskText}</p> : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader title="Conversation" />
          <Captions data={data} tutorShown={tutorShown} />
        </Card>
        <Card>
          <CardHeader title="Board" />
          <div className="p-4">
            <Board items={data.boardItems} progress={progress} serverOver={serverOver} />
          </div>
        </Card>
      </div>
      <DebugPanel data={data} />
    </div>
  );
}
