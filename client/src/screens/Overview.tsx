// Screen 4: all active sessions with learner, phase and turn state; open any as observer.
import { useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Session } from '../module_bindings/types';
import { subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { Badge, Card, CardHeader, ErrorNote } from '../components/ui';
import { phaseLabel, sessionUrl, topicLabel, tsMs } from '../lib/format';

export function Overview({ conn }: { conn: DbConnection }) {
  const [error, setError] = useState('');
  useEffect(() => {
    const sub = subscribe(conn, ['SELECT * FROM session WHERE active = true', 'SELECT * FROM learner'], 'overview');
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn]);

  const sessions = useRows<Session>(conn.db.session, s => s.active, []).sort((a, b) => Number(b.id - a.id));
  const learners = useRows<Learner>(conn.db.learner, () => true, []);
  const name = (id: bigint) => learners.find(l => l.id === id)?.name ?? `Learner ${id}`;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Active sessions</h1>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        <CardHeader title={`${sessions.length} active`} />
        <table data-testid="overview-table" className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Learner</th>
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Phase</th>
              <th className="px-4 py-2 font-medium">Topic</th>
              <th className="px-4 py-2 font-medium">Turn state</th>
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-muted-foreground">
                  No active sessions.
                </td>
              </tr>
            ) : null}
            {sessions.map(s => (
              <tr key={s.id.toString()} data-testid="overview-row" data-session-id={s.id.toString()} data-phase={s.phase} data-turn-state={s.turnState} className="border-t">
                <td className="px-4 py-2 font-medium">{name(s.learnerId)}</td>
                <td className="px-4 py-2 font-mono">{s.code || s.id.toString()}</td>
                <td className="px-4 py-2">{phaseLabel(s.phase)}</td>
                <td className="px-4 py-2 text-muted-foreground">{topicLabel(s.category, s.concept)}</td>
                <td className="px-4 py-2">
                  <Badge>{s.turnState || '—'}</Badge>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{new Date(tsMs(s.startedAt) ?? 0).toLocaleTimeString()}</td>
                <td className="px-4 py-2 text-right">
                  <a data-testid="overview-observe" href={sessionUrl('observe', s.id)} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    Observe
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
