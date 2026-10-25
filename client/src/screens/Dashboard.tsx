// Teacher dashboard (?class=<classSessionId>), user spec in docs/NIGHT_PLAN.md "Classroom feature":
// top: the class learning-state summary (class_summary; the module refreshes it every 30 s, the
// button calls refreshDashboard); below: the clusters (student_cluster, 2 or 4 students each, four
// student cards per row); hover a card → Observe → the student's live session (<SessionView
// readOnly />) in a frame with previous / next / stop. Observing calls setImpersonation, which
// pauses the summaries in the module (and catches up at once on stop when a refresh is overdue).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ClassSession, ClassSummary, DashboardState, Learner, LessonState, Session, StudentCluster, Teacher, Turn } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { navigate, phaseLabel, routeUrl, tsMs } from '../lib/format';
import { agoLabel, clusterRows, nextLabel, observeOrder, parseLearnerIds, stepObserve, ungroupedIds, type ClusterBlock } from '../lib/dashboard';
import { eventLog } from '../lib/debug';
import { parseNotes } from '@tutor/visual/teaching/spacetimeModel';
import { typedTurnText } from '../components/session';
import { SessionView } from '../session/SessionView';
import { STAGE_LABELS } from '../session/stages';
import { Initial } from './StudentHome';

interface Student {
  id: string;
  learner: Learner | undefined;
  session: Session;
  stage: string;
  lastIn: string;
  lastOut: string;
  lastOrder: 'in-first' | 'out-first';
  turns: number;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Dashboard({ conn, classSessionId }: { conn: DbConnection; classSessionId: bigint }) {
  const [error, setError] = useState('');
  const cid = classSessionId.toString();
  useEffect(() => {
    const sub = subscribe(
      conn,
      [
        `SELECT * FROM class_session WHERE id = ${cid}`,
        `SELECT * FROM class_summary WHERE class_session_id = ${cid}`,
        `SELECT * FROM student_cluster WHERE class_session_id = ${cid}`,
        `SELECT * FROM dashboard_state WHERE class_session_id = ${cid}`,
        `SELECT * FROM session WHERE class_session_id = ${cid}`,
        'SELECT * FROM learner',
        'SELECT * FROM teacher',
      ],
      `dashboard ${cid}`
    );
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn, cid]);

  const cls = useRows<ClassSession>(conn.db.classSession, c => c.id === classSessionId, [classSessionId])[0];
  const summary = useRows<ClassSummary>(conn.db.classSummary, c => c.classSessionId === classSessionId, [classSessionId])[0];
  const state = useRows<DashboardState>(conn.db.dashboardState, c => c.classSessionId === classSessionId, [classSessionId])[0];
  const clusterRowsRaw = useRows<StudentCluster>(conn.db.studentCluster, c => c.classSessionId === classSessionId, [classSessionId]);
  const sessions = useRows<Session>(conn.db.session, s => s.classSessionId === classSessionId && s.active, [classSessionId]);
  const learners = useRows<Learner>(conn.db.learner, () => true, []);
  const teacher = useRows<Teacher>(conn.db.teacher, t => t.id === cls?.teacherId, [cls?.teacherId])[0];

  // Per-student rows: chat in/out (turn) and the lesson stage (lesson_state) of every linked session.
  const sessionKey = sessions.map(s => s.id.toString()).sort().join(',');
  useEffect(() => {
    if (!sessionKey) return;
    const ids = sessionKey.split(',');
    const sub = subscribe(conn, ids.flatMap(id => [`SELECT * FROM turn WHERE session_id = ${id}`, `SELECT * FROM lesson_state WHERE session_id = ${id}`]), `dashboard turns ${ids.length}`);
    return () => sub.unsubscribe();
  }, [conn, sessionKey]);
  const sessionIds = useMemo(() => new Set(sessionKey.split(',')), [sessionKey]);
  const turns = useRows<Turn>(conn.db.turn, t => sessionIds.has(t.sessionId.toString()), [sessionIds]);
  const lessons = useRows<LessonState>(conn.db.lessonState, l => sessionIds.has(l.sessionId.toString()), [sessionIds]);

  const students = useMemo(() => {
    const m = new Map<string, Student>();
    const bySession = new Map<string, Turn[]>();
    for (const t of turns) bySession.set(t.sessionId.toString(), [...(bySession.get(t.sessionId.toString()) ?? []), t]);
    for (const s of [...sessions].sort((a, b) => Number(a.id - b.id))) {
      const ts = (bySession.get(s.id.toString()) ?? []).sort((a, b) => a.idx - b.idx);
      const lastIn = [...ts].reverse().find(t => t.role === 'student' && (t.text || t.intent));
      const lastOut = [...ts].reverse().find(t => t.role === 'tutor' && t.text);
      const notes = parseNotes(lessons.find(l => l.sessionId === s.id));
      m.set(s.learnerId.toString(), {
        id: s.learnerId.toString(),
        learner: learners.find(l => l.id === s.learnerId),
        session: s,
        stage: STAGE_LABELS[notes.phase ?? ''] ?? (s.phase ? phaseLabel(s.phase) : 'Starting'),
        lastIn: lastIn ? typedTurnText(lastIn.text, lastIn.intent) : '',
        lastOut: lastOut?.text ?? '',
        lastOrder: lastIn && lastOut && lastIn.idx > lastOut.idx ? 'out-first' : 'in-first',
        turns: ts.filter(t => t.role === 'student').length,
      });
    }
    return m;
  }, [sessions, turns, lessons, learners]);

  const rows = useMemo(
    () =>
      clusterRows(
        clusterRowsRaw.map(c => ({ id: c.id.toString(), position: c.position, name: c.name, description: c.description, learnerIds: parseLearnerIds(c.learnerIds).filter(id => students.has(id)) })).filter(c => c.learnerIds.length > 0)
      ),
    [clusterRowsRaw, students]
  );
  const ungrouped = useMemo(() => ungroupedIds([...students.keys()], rows), [students, rows]);
  const order = useMemo(() => observeOrder(rows, ungrouped), [rows, ungrouped]);
  const clusterOf = useCallback((id: string) => rows.flat().find(c => c.learnerIds.includes(id)), [rows]);

  // ------------------------------------------------------------ observe (impersonation)
  const [observing, setObserving] = useState<string | null>(null);
  const impersonate = useCallback(
    (learnerId: string | null) => {
      const args = { classSessionId, learnerId: learnerId ? BigInt(learnerId) : 0n };
      eventLog.log('ui.impersonate', { learnerId: learnerId ?? '0' });
      void callReducer('setImpersonation', args, () => conn.reducers.setImpersonation(args));
    },
    [conn, classSessionId]
  );
  const observe = (id: string | null) => {
    setObserving(id);
    impersonate(id);
  };
  // Leaving the page while observing resumes the summaries.
  useEffect(() => {
    if (!observing) return;
    const stop = () => impersonate(null);
    window.addEventListener('pagehide', stop);
    return () => window.removeEventListener('pagehide', stop);
  }, [observing, impersonate]);
  const observingRef = useRef<string | null>(null);
  observingRef.current = observing;
  useEffect(
    () => () => {
      // unmount (navigation away) while observing
      if (observingRef.current) impersonate(null);
    },
    [impersonate]
  );

  // ------------------------------------------------------------ refresh + timers
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote('');
    eventLog.log('procedure.call', { name: 'refreshDashboard' });
    try {
      const out = await conn.procedures.refreshDashboard({ classSessionId });
      const r = JSON.parse(out || '{}') as { ok?: boolean; skipped?: string; error?: string };
      eventLog.log('procedure.ok', { name: 'refreshDashboard', result: out });
      if (!r.ok) setRefreshNote(r.skipped ? `Skipped (${r.skipped.replace(/_/g, ' ')})` : `Update failed${r.error ? `: ${r.error}` : ''}`);
    } catch (err) {
      setRefreshNote(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  };
  const updatedMs = summary ? tsMs(summary.updatedAt) : null;
  const next = !cls?.active ? '' : nextLabel(now, { running: refreshing || !!state?.running, impersonating: !!observing, nextDueMs: state ? tsMs(state.nextDueAt) : null, lastError: state?.lastError ?? '' });

  // ------------------------------------------------------------ end class
  const [confirmEnd, setConfirmEnd] = useState(false);
  const endClass = async () => {
    if (observing) observe(null);
    const r = await callReducer('endClassSession', { classSessionId }, () => conn.reducers.endClassSession({ classSessionId }));
    if (!r.ok) setError(r.error ?? 'failed');
    setConfirmEnd(false);
  };

  const [tab, setTab] = useState<'groups' | 'all'>('groups');

  useEffect(() => {
    window.__tutor.state.dashboard = {
      classSessionId: cid,
      active: !!cls?.active,
      students: students.size,
      clusters: rows.flat().map(c => ({ name: c.name, size: c.learnerIds.length, slots: c.slots })),
      rows: rows.map(r => r.map(c => c.learnerIds.length)),
      order,
      observing,
      summaryVersion: summary?.version ?? 0,
    };
  }, [cid, cls?.active, students.size, rows, order, observing, summary?.version]);

  if (!cls) return <p className="pr-note" style={{ padding: '64px 0', textAlign: 'center' }}>{error || 'Opening the class…'}</p>;

  const observed = observing ? students.get(observing) : undefined;
  const title = cls.content || cls.goals || 'Class session';

  return (
    <div data-testid="dashboard-screen" data-class-session-id={cid} data-active={cls.active}>
      <header className="db-head">
        <div style={{ minWidth: 0 }}>
          <span className="pr-eyebrow">
            {teacher?.name ?? 'Class'} · {students.size} student{students.size === 1 ? '' : 's'}
            {cls.simulation ? ` · ${cls.simulatedCount} simulated` : ''} · since {new Date(tsMs(cls.startedAt) ?? 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <h1>{title}</h1>
        </div>
        <div className="db-head-actions">
          {!cls.active ? (
            <>
              <span className="pr-note" data-testid="class-ended">Class ended</span>
              <button className="pr-secondary" onClick={() => navigate(routeUrl({ teacher: cls.teacherId }))}>New class</button>
            </>
          ) : confirmEnd ? (
            <>
              <button className="pr-link" onClick={() => setConfirmEnd(false)}>Cancel</button>
              <button className="pr-primary" data-testid="end-class-confirm" onClick={endClass}>
                <span>End for everyone</span>
              </button>
            </>
          ) : (
            <button className="pr-secondary" data-testid="end-class" onClick={() => setConfirmEnd(true)}>End class session</button>
          )}
        </div>
      </header>
      {error && <p className="pr-error" data-testid="error">{error}</p>}

      <section className="db-summary" data-testid="class-summary" data-version={summary?.version ?? 0} aria-label="Class learning state">
        {summary?.summary ? <p>{summary.summary}</p> : <p className="db-pending">The first summary of the class arrives about half a minute after the start.</p>}
        <div className="db-fresh">
          <span data-testid="summary-updated" data-updated-ms={updatedMs ?? ''}>
            {updatedMs === null ? "No summary yet" : `Updated ${agoLabel(now, updatedMs)}`}
            {next ? ` · ${next}` : ''}
          </span>
          {cls.active && (
            <button className="pr-secondary" data-testid="refresh-dashboard" disabled={refreshing || !!state?.running} onClick={refresh}>
              {refreshing || state?.running ? 'Updating…' : 'Refresh'}
            </button>
          )}
        </div>
        {refreshNote && <span className="pr-note" data-testid="refresh-note">{refreshNote}</span>}
      </section>

      <div className="db-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'groups'} data-testid="tab-groups" onClick={() => setTab('groups')}>Groups<span>{rows.flat().length}</span></button>
        <button role="tab" aria-selected={tab === 'all'} data-testid="tab-all" onClick={() => setTab('all')}>All sessions<span>{students.size}</span></button>
      </div>

      {tab === 'groups' ? (
        <div className="db-rows" data-testid="cluster-grid">
          {students.size === 0 && <p className="pr-note">{cls.active ? 'No students in this class yet. Students who are waiting join when a class starts.' : 'This class has ended. The students are back in the waiting room.'}</p>}
          {rows.map((row, i) => (
            <div key={i} className="db-row" data-testid="cluster-row" data-sizes={row.map(c => c.learnerIds.length).join('+')}>
              {row.map(c => (
                <Cluster key={c.id} cluster={c} students={students} onObserve={observe} />
              ))}
            </div>
          ))}
          {ungrouped.length > 0 && (
            <>
              {rows.length > 0 && <p className="db-ungrouped-title">Not grouped yet</p>}
              <div className="db-row" data-testid="ungrouped">
                {ungrouped.map(id => (
                  <StudentCard key={id} s={students.get(id)!} onObserve={observe} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <AllSessions order={order} students={students} clusterOf={clusterOf} onObserve={observe} />
      )}

      <footer className="db-footer">
        <span>Groups have two or four students (one group of three when the class is odd). The summary updates every 30 s and pauses while you observe a student.</span>
        {state?.lastError ? <span data-testid="dashboard-error">Last update failed: {state.lastError}</span> : null}
      </footer>

      {observing && (
        <ObserveFrame
          conn={conn}
          student={observed}
          cluster={clusterOf(observing)}
          position={order.indexOf(observing)}
          total={order.length}
          onStep={d => {
            const nextId = stepObserve(order, observing, d);
            if (nextId && nextId !== observing) observe(nextId);
          }}
          onStop={() => observe(null)}
        />
      )}
    </div>
  );
}

function Cluster({ cluster, students, onObserve }: { cluster: ClusterBlock; students: Map<string, Student>; onObserve: (id: string) => void }) {
  return (
    <section className="db-cluster" data-testid="cluster" data-slots={cluster.slots} data-size={cluster.learnerIds.length} aria-label={cluster.name}>
      <div className="db-cluster-head">
        <h3 data-testid="cluster-name">{cluster.name}</h3>
        <p data-testid="cluster-description">{cluster.description}</p>
      </div>
      <div className="db-cards">
        {cluster.learnerIds.map(id => {
          const s = students.get(id);
          return s ? <StudentCard key={id} s={s} cluster={cluster.name} onObserve={onObserve} /> : null;
        })}
      </div>
    </section>
  );
}

function StudentCard({ s, cluster, onObserve }: { s: Student; cluster?: string; onObserve: (id: string) => void }) {
  const name = s.learner?.name ?? `Student ${s.id}`;
  const out = s.lastOut ? { k: 'out', who: 'Tutor', text: s.lastOut } : null;
  const inp = s.lastIn ? { k: 'in', who: name.split(' ')[0]!, text: s.lastIn } : null;
  // chronological: the newer line last
  const lines = (s.lastOrder === 'out-first' ? [out, inp] : [inp, out]).filter((l): l is { k: string; who: string; text: string } => !!l);
  return (
    <article className="db-card" data-testid="student-card" data-learner-id={s.id} data-session-id={s.session.id.toString()} data-cluster={cluster ?? ''} tabIndex={-1}>
      <div className="db-card-top">
        <Initial name={name} />
        <strong>{name}</strong>
        <span className="db-turn" data-state={s.session.turnState} title={s.session.turnState} />
        <span className="db-stage" data-testid="student-stage">{s.stage}</span>
      </div>
      <div className="db-chat" data-testid="student-chat">
        {lines.length === 0 ? <p>Getting started…</p> : lines.map(l => (
          <p key={l.k} className={l.k === 'in' ? 'db-in' : ''}>
            <b>{l.who}</b>
            {l.text}
          </p>
        ))}
      </div>
      <button className="pr-primary db-observe" data-testid="observe-student" data-learner-id={s.id} onClick={() => onObserve(s.id)}>
        <span>Observe</span>
      </button>
    </article>
  );
}

function AllSessions({ order, students, clusterOf, onObserve }: { order: string[]; students: Map<string, Student>; clusterOf: (id: string) => ClusterBlock | undefined; onObserve: (id: string) => void }) {
  return (
    <table className="db-table" data-testid="all-sessions">
      <thead>
        <tr>
          <th>Student</th>
          <th>Group</th>
          <th>Stage</th>
          <th>Tutor</th>
          <th>Turns</th>
          <th>Latest</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {order.map(id => {
          const s = students.get(id);
          if (!s) return null;
          return (
            <tr key={id} data-testid="all-sessions-row" data-learner-id={id} data-session-id={s.session.id.toString()}>
              <td><strong>{s.learner?.name ?? id}</strong></td>
              <td>{clusterOf(id)?.name ?? '—'}</td>
              <td>{s.stage}</td>
              <td>{s.session.turnState || '—'}</td>
              <td>{s.turns}</td>
              <td className="db-last"><span>{s.lastIn || s.lastOut || '—'}</span></td>
              <td style={{ textAlign: 'right' }}>
                <button className="pr-secondary" data-testid="observe-student-row" onClick={() => onObserve(id)}>Observe</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ObserveFrame({ conn, student, cluster, position, total, onStep, onStop }: { conn: DbConnection; student: Student | undefined; cluster: ClusterBlock | undefined; position: number; total: number; onStep: (d: -1 | 1) => void; onStop: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStop();
      else if (e.key === 'ArrowLeft' && e.altKey) onStep(-1);
      else if (e.key === 'ArrowRight' && e.altKey) onStep(1);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onStep, onStop]);
  const name = student?.learner?.name ?? 'Student';
  return (
    <div className="db-frame-backdrop" role="dialog" aria-modal="true" aria-label={`Observing ${name}`}>
      <div className="db-frame" data-testid="observe-frame" data-learner-id={student?.id ?? ''} data-session-id={student?.session.id.toString() ?? ''}>
        <div className="db-frame-bar">
          <div className="db-who">
            <Initial name={name} />
            <strong data-testid="observe-name">{name}</strong>
            <small>{[cluster?.name, student?.stage].filter(Boolean).join(' · ')} · summaries paused</small>
          </div>
          <div className="db-frame-nav">
            <span>{position + 1} / {total}</span>
            <button className="pr-secondary" data-testid="observe-prev" onClick={() => onStep(-1)} disabled={total < 2}>← Previous</button>
            <button className="pr-secondary" data-testid="observe-next" onClick={() => onStep(1)} disabled={total < 2}>Next →</button>
            <button className="pr-primary" data-testid="observe-stop" onClick={onStop}><span>Stop observing</span></button>
          </div>
        </div>
        <div className="db-frame-body">
          {student ? <SessionView key={student.session.id.toString()} conn={conn} sessionId={student.session.id} readOnly embedded /> : <p className="pr-note">This student left the class.</p>}
        </div>
      </div>
    </div>
  );
}
