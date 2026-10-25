// Waiting room (?wait=<learnerId>): presence 'waiting' until a teacher starts a class session,
// which links a new session for this learner (startClassSession). Then the tab jumps into it:
// ?session=<id>&join=1. The session screen asks for one click to turn on sound (voice) and then
// calls startConversation; a typed session starts at once.
import { useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Session } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { setPresence, usePresence } from '../stdb/usePresence';
import { classSessionToJoin } from '../lib/presence';
import { navigate, routeUrl, sessionUrl } from '../lib/format';
import { eventLog } from '../lib/debug';
import { TutorAvatar } from '../components/TutorAvatar';

export function WaitingRoom({ conn, learnerId }: { conn: DbConnection; learnerId: bigint }) {
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(() => new URLSearchParams(window.location.search).get('voice') === '0');
  useEffect(() => {
    const id = learnerId.toString();
    const sub = subscribe(conn, [`SELECT * FROM learner WHERE id = ${id}`, `SELECT * FROM session WHERE learner_id = ${id}`], `wait ${id}`);
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn, learnerId]);
  const learner = useRows<Learner>(conn.db.learner, l => l.id === learnerId, [learnerId])[0];
  const sessions = useRows<Session>(conn.db.session, s => s.learnerId === learnerId, [learnerId]);
  usePresence(conn, learnerId, 'waiting');

  const target = classSessionToJoin(sessions, learnerId);
  const joined = useRef<bigint | null>(null);
  useEffect(() => {
    if (!target || joined.current === target.id) return;
    joined.current = target.id;
    eventLog.log('ui.class_join', { sessionId: target.id.toString(), classSessionId: target.classSessionId.toString(), typing });
    void (async () => {
      if (typing && target.voice) {
        const args = { sessionId: target.id, voice: false };
        const r = await callReducer('setSessionVoice', args, () => conn.reducers.setSessionVoice(args));
        if (!r.ok) eventLog.log('ui.text_mode_failed', { error: r.error });
      }
      navigate(sessionUrl('session', target.id, { join: '1' }));
    })();
  }, [target, typing, conn]);

  const leave = async () => {
    await setPresence(conn, learnerId, 'offline');
    navigate(routeUrl({ student: learnerId }));
  };

  return (
    <div className="pr-wait" data-testid="waiting-screen" data-learner-id={learnerId.toString()}>
      <TutorAvatar state="idle" size={96} label="The tutor is waiting with you" />
      <h1>Waiting for your teacher{learner ? `, ${learner.name}` : ''}</h1>
      <p>Your lesson opens by itself when the class starts. Keep this page open.</p>
      <div className="pr-wait-rule" />
      <span className="pr-wait-status" role="status" data-testid="waiting-status">
        <i />
        {target ? 'Your class is starting…' : 'Ready and waiting'}
      </span>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      <div className="pr-wait-actions">
        <label className="pr-check">
          <input data-testid="text-mode" type="checkbox" checked={typing} onChange={e => setTyping(e.target.checked)} />
          Type instead of talking (no sound)
        </label>
        <button className="pr-link" data-testid="leave-waiting" onClick={leave}>Leave the waiting room</button>
      </div>
    </div>
  );
}
