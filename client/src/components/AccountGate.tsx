// Screens that act as an account (student start/waiting room/lesson, teacher setup/dashboard/
// profile) open only on a device signed in as that account. The module enforces the same rules
// on every reducer (spacetimedb/src/auth.ts); this gate just explains it instead of failing calls.
import { useEffect, type ReactNode } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ClassSession, Session } from '../module_bindings/types';
import { AUTH_ERRORS } from '@tutor/shared/auth';
import { subscribe } from '../stdb/connection';
import { useAccounts } from '../stdb/useAccounts';
import { useRows } from '../stdb/useRows';
import { navigate, routeUrl } from '../lib/format';

export type GateTarget =
  | { kind: 'learner'; id: bigint }
  | { kind: 'teacher'; id: bigint }
  | { kind: 'session'; id: bigint }
  | { kind: 'class'; id: bigint };

export function AccountGate({ conn, target, children }: { conn: DbConnection; target: GateTarget; children: ReactNode }) {
  const acc = useAccounts(conn);
  const sid = target.kind === 'session' ? target.id : null;
  const cid = target.kind === 'class' ? target.id : null;
  useEffect(() => {
    if (sid === null && cid === null) return;
    const q = sid !== null ? `SELECT * FROM session WHERE id = ${sid}` : `SELECT * FROM class_session WHERE id = ${cid}`;
    const sub = subscribe(conn, [q], 'gate');
    return () => sub.unsubscribe();
  }, [conn, sid, cid]);
  const session = useRows<Session>(sid === null ? null : conn.db.session, s => s.id === sid, [sid])[0];
  const cls = useRows<ClassSession>(cid === null ? null : conn.db.classSession, c => c.id === cid, [cid])[0];

  if (!acc.ready) return <p className="pr-note" style={{ padding: '64px 0', textAlign: 'center' }}>Checking this device…</p>;
  const learnerOk = (id: bigint) => acc.learners.some(l => l.id === id);
  const teacherOk = (id: bigint) => acc.teachers.some(t => t.id === id);

  let ok: boolean | null;
  let message: string;
  let home: 'student' | 'teacher';
  switch (target.kind) {
    case 'learner':
      ok = learnerOk(target.id);
      message = AUTH_ERRORS.learnerOtherDevice;
      home = 'student';
      break;
    case 'teacher':
      ok = teacherOk(target.id);
      message = AUTH_ERRORS.teacherOtherDevice;
      home = 'teacher';
      break;
    case 'session':
      // Unknown session: let the session screen show its own "not found".
      ok = session ? learnerOk(session.learnerId) : true;
      message = `${AUTH_ERRORS.sessionOtherDevice} If it is yours, ask your teacher for a code.`;
      home = 'student';
      break;
    case 'class':
      ok = cls ? teacherOk(cls.teacherId) : true;
      message = AUTH_ERRORS.classOtherTeacher;
      home = 'teacher';
      break;
  }
  if (ok) return <>{children}</>;
  return (
    <div className="pr-intro" data-testid="account-gate" data-kind={target.kind} style={{ paddingTop: 48 }}>
      <span className="pr-eyebrow">Not on this device</span>
      <h1>{message}</h1>
      <p>Each device keeps its own sign-in. Use the device you signed up on, or enter a sign-in code.</p>
      <button className="pr-primary" data-testid="gate-home" onClick={() => navigate(routeUrl({ [home]: '' }))}>
        <span>{home === 'student' ? 'Go to my students' : 'Go to my teacher accounts'}</span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
