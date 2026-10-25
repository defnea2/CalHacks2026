// All active sessions (ad-hoc and class) with learner, phase and turn state; open any as observer.
// A class's own big picture lives in its dashboard ("All sessions" tab).
import { useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ClassSession, Learner, Session } from '../module_bindings/types';
import { subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { navigate, phaseLabel, routeUrl, sessionUrl, topicLabel, tsMs } from '../lib/format';

export function Overview({ conn }: { conn: DbConnection }) {
  const [error, setError] = useState('');
  useEffect(() => {
    const sub = subscribe(conn, ['SELECT * FROM session WHERE active = true', 'SELECT * FROM learner', 'SELECT * FROM class_session WHERE active = true'], 'overview');
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn]);

  const sessions = useRows<Session>(conn.db.session, s => s.active, []).sort((a, b) => Number(b.id - a.id));
  const learners = useRows<Learner>(conn.db.learner, () => true, []);
  const classes = useRows<ClassSession>(conn.db.classSession, c => c.active, []);
  const name = (id: bigint) => learners.find(l => l.id === id)?.name ?? `Learner ${id}`;

  return (
    <div>
      <section className="pr-intro" style={{ paddingBottom: 18 }}>
        <span className="pr-eyebrow">Overview</span>
        <h1>Active sessions</h1>
        <p>{sessions.length} running{classes.length ? ` · ${classes.length} class session${classes.length === 1 ? '' : 's'}` : ''}. Observe opens a read-only view.</p>
      </section>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      {classes.length > 0 && (
        <div className="pr-people" style={{ marginBottom: 22 }}>
          {classes.map(c => (
            <button key={c.id.toString()} className="pr-person" data-testid="overview-class" onClick={() => navigate(routeUrl({ class: c.id }))}>
              <span>
                <strong>{c.content || c.goals || `Class ${c.id}`}</strong>
                <small>Open the class dashboard →</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <table data-testid="overview-table" className="db-table">
        <thead>
          <tr>
            <th>Learner</th>
            <th>Code</th>
            <th>Phase</th>
            <th>Topic</th>
            <th>Turn state</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 ? (
            <tr>
              <td colSpan={7} className="pr-note">No active sessions.</td>
            </tr>
          ) : null}
          {sessions.map(s => (
            <tr key={s.id.toString()} data-testid="overview-row" data-session-id={s.id.toString()} data-phase={s.phase} data-turn-state={s.turnState}>
              <td><strong>{name(s.learnerId)}</strong>{s.classSessionId !== 0n ? <small className="pr-note"> · class</small> : null}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace' }}>{s.code || s.id.toString()}</td>
              <td>{phaseLabel(s.phase)}</td>
              <td>{topicLabel(s.category, s.concept)}</td>
              <td>{s.turnState || '—'}</td>
              <td>{new Date(tsMs(s.startedAt) ?? 0).toLocaleTimeString()}</td>
              <td style={{ textAlign: 'right' }}>
                <a data-testid="overview-observe" className="pr-secondary" href={sessionUrl('observe', s.id)} target="_blank" rel="noreferrer">Observe</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
