// Teacher dashboard (?class=<classSessionId>), user spec in docs/NIGHT_PLAN.md "Classroom feature":
// top: the class learning-state summary (class_summary; the module refreshes it every 30 s, the
// button calls refreshDashboard); below: the clusters (student_cluster, 2 or 4 students each, four
// student cards per row; the odd student of an odd class in "Not grouped yet" at the end). Each
// card is a small live chat window (StudentCard): the class's `turn` + `reply_sentence` rows,
// subscribed once per class, stream in as bubbles. Hover / focus a card → Observe (the student's
// live session, <SessionView readOnly />, in a frame with previous / next / stop) or Profile (the
// half-screen drawer). Observing calls setImpersonation, which pauses the summaries in the module
// (and catches up at once on stop when a refresh is overdue).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ClassSession, ClassSummary, DashboardState, Learner, LessonState, ReplySentence, Session, StudentCluster, Teacher, Turn } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { navigate, phaseLabel, routeUrl, tsMs } from '../lib/format';
import { agoLabel, clusterRows, nextLabel, observeOrder, clusterMemberIds, stepObserve, ungroupedIds, type ClusterBlock, refreshResult } from '../lib/dashboard';
import { eventLog } from '../lib/debug';
import { parseNotes } from '@tutor/visual/teaching/spacetimeModel';
import { typedTurnText } from '../components/session';
import { SessionView } from '../session/SessionView';
import { STAGE_LABELS } from '../session/stages';
import { Initial } from './StudentHome';
import { ProfileDrawer } from '../insights/ProfileDrawer';
import { bubblesSignature, sessionBubbles, type Bubble } from '../lib/bubbles';
import { NextIcon, ObserveIcon, PrevIcon, ProfileIcon, StopIcon } from '../brand/icons';
import { StudentCard } from './StudentCard';

interface Student {
  id: string;
  learner: Learner | undefined;
  session: Session;
  stage: string;
  lastIn: string;
  lastOut: string;
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
        // Only the learners of this class's sessions and its teacher (JOIN subscriptions).
        `SELECT l.* FROM learner l JOIN session s ON l.id = s.learner_id WHERE s.class_session_id = ${cid}`,
        `SELECT t.* FROM teacher t JOIN class_session c ON t.id = c.teacher_id WHERE c.id = ${cid}`,
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

  // Per-student rows of every linked session, in ONE subscription for the class (not per card):
  // chat in/out (turn), tutor sentences as they are played (reply_sentence), lesson stage.
  const sessionKey = sessions.map(s => s.id.toString()).sort().join(',');
  useEffect(() => {
    if (!sessionKey) return;
    const ids = sessionKey.split(',');
    const sub = subscribe(
      conn,
      ids.flatMap(id => [`SELECT * FROM turn WHERE session_id = ${id}`, `SELECT * FROM reply_sentence WHERE session_id = ${id}`, `SELECT * FROM lesson_state WHERE session_id = ${id}`]),
      `dashboard live ${ids.length}`
    );
    return () => sub.unsubscribe();
  }, [conn, sessionKey]);
  const sessionIds = useMemo(() => new Set(sessionKey.split(',')), [sessionKey]);
  const turns = useRows<Turn>(conn.db.turn, t => sessionIds.has(t.sessionId.toString()), [sessionIds]);
  const sentences = useRows<ReplySentence>(conn.db.replySentence, r => sessionIds.has(r.sessionId.toString()), [sessionIds]);
  const lessons = useRows<LessonState>(conn.db.lessonState, l => sessionIds.has(l.sessionId.toString()), [sessionIds]);

  // Bubbles per session; an unchanged list keeps its previous array so the (memo) card skips.
  const bubbleCache = useRef(new Map<string, { sig: string; bubbles: Bubble[] }>());
  const bubbles = useMemo(() => {
    const turnsBy = new Map<string, Turn[]>();
    for (const t of turns) turnsBy.set(t.sessionId.toString(), [...(turnsBy.get(t.sessionId.toString()) ?? []), t]);
    const sentBy = new Map<string, ReplySentence[]>();
    for (const r of sentences) sentBy.set(r.sessionId.toString(), [...(sentBy.get(r.sessionId.toString()) ?? []), r]);
    const out = new Map<string, Bubble[]>();
    for (const id of sessionIds) {
      if (!id) continue;
      const list = sessionBubbles(
        (turnsBy.get(id) ?? []).map(t => ({ idx: t.idx, role: t.role, text: t.text, intent: t.intent, utteranceId: t.utteranceId.toString(), createdAtMs: tsMs(t.createdAt) ?? 0 })),
        (sentBy.get(id) ?? []).map(r => ({ utteranceId: r.utteranceId.toString(), idx: r.idx, display: r.display, speech: r.speech, status: r.status, createdAtMs: tsMs(r.createdAt) ?? 0 })),
        { label: typedTurnText }
      );
      const sig = bubblesSignature(list);
      const hit = bubbleCache.current.get(id);
      if (hit && hit.sig === sig) out.set(id, hit.bubbles);
      else {
        bubbleCache.current.set(id, { sig, bubbles: list });
        out.set(id, list);
      }
    }
    for (const id of bubbleCache.current.keys()) if (!sessionIds.has(id)) bubbleCache.current.delete(id);
    return out;
  }, [turns, sentences, sessionIds]);

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
        turns: ts.filter(t => t.role === 'student').length,
      });
    }
    return m;
  }, [sessions, turns, lessons, learners]);

  const rows = useMemo(
    () =>
      clusterRows(
        clusterRowsRaw.map(c => ({ id: c.id.toString(), position: c.position, name: c.name, description: c.description, learnerIds: clusterMemberIds(c).filter(id => students.has(id)) })).filter(c => c.learnerIds.length > 0)
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
  const observe = useCallback(
    (id: string | null) => {
      setObserving(id);
      impersonate(id);
    },
    [impersonate]
  );
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
      const r = refreshResult(out);
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
  const [profileId, setProfileId] = useState<string | null>(null);
  const closeProfile = useCallback(() => setProfileId(null), []);

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
  // "Not grouped yet": the odd student of an odd class (or everyone before the first summary).
  // It fills the half-empty last row when it fits, otherwise it gets a row of its own.
  const lastRow = rows[rows.length - 1];
  const ungroupedInline = !!lastRow && ungrouped.length <= 2 && lastRow.reduce((n, c) => n + c.slots, 0) === 2;
  const ungroupedSlot =
    ungrouped.length > 0 ? (
      <section className="db-cluster db-cluster-ungrouped" data-testid="ungrouped" data-slots={ungrouped.length <= 2 ? 2 : 4} aria-label="Not grouped yet">
        {rows.length > 0 && (
          <div className="db-cluster-head">
            <h3 className="db-ungrouped-title">Not grouped yet</h3>
          </div>
        )}
        <div className="db-cards">
          {ungrouped.map(id => (
            <Card key={id} s={students.get(id)!} bubbles={bubbles} onObserve={observe} onProfile={setProfileId} />
          ))}
        </div>
      </section>
    ) : null;

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

      <div className="db-view-switch">
        {tab === 'groups' ? (
          <button className="db-textlink" data-testid="tab-all" onClick={() => setTab('all')}>All sessions ({students.size})</button>
        ) : (
          <button className="db-textlink" data-testid="tab-groups" onClick={() => setTab('groups')}>← Back to groups</button>
        )}
      </div>

      {tab === 'groups' ? (
        <div className="db-rows" data-testid="cluster-grid">
          {students.size === 0 && <p className="pr-note">{cls.active ? 'No students in this class yet. Students who are waiting join when a class starts.' : 'This class has ended. The students are back in the waiting room.'}</p>}
          {rows.map((row, i) => (
            <div key={i} className="db-row" data-testid="cluster-row" data-sizes={row.map(c => c.learnerIds.length).join('+')}>
              {row.map(c => (
                <Cluster key={c.id} cluster={c} students={students} bubbles={bubbles} onObserve={observe} onProfile={setProfileId} />
              ))}
              {i === rows.length - 1 && ungroupedInline && ungroupedSlot}
            </div>
          ))}
          {ungrouped.length > 0 && !ungroupedInline && (
            <div className="db-row" data-testid="ungrouped-row">
              {ungroupedSlot}
            </div>
          )}
        </div>
      ) : (
        <AllSessions order={order} students={students} clusterOf={clusterOf} onObserve={observe} onProfile={setProfileId} />
      )}

      <footer className="db-footer">
        <span>Groups have two or four students; in an odd class one student waits in “Not grouped yet”. The summary updates every 30 s and pauses while you observe a student.</span>
        {state?.lastError ? <span data-testid="dashboard-error">Last update failed: {state.lastError}</span> : null}
      </footer>

      {profileId && <ProfileDrawer conn={conn} learnerId={BigInt(profileId)} teacherId={cls.teacherId} name={students.get(profileId)?.learner?.name} onClose={closeProfile} />}

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

function Cluster({ cluster, students, bubbles, onObserve, onProfile }: { cluster: ClusterBlock; students: Map<string, Student>; bubbles: Map<string, Bubble[]>; onObserve: (id: string) => void; onProfile: (id: string) => void }) {
  return (
    <section className="db-cluster" data-testid="cluster" data-slots={cluster.slots} data-size={cluster.learnerIds.length} aria-label={cluster.name}>
      <div className="db-cluster-head">
        <h3 data-testid="cluster-name">{cluster.name}</h3>
        <p data-testid="cluster-description">{cluster.description}</p>
      </div>
      <div className="db-cards">
        {cluster.learnerIds.map(id => {
          const s = students.get(id);
          return s ? <Card key={id} s={s} bubbles={bubbles} cluster={cluster.name} onObserve={onObserve} onProfile={onProfile} /> : null;
        })}
      </div>
    </section>
  );
}

const NO_BUBBLES: Bubble[] = [];

/** Flattens a student to the memo card's primitive props. */
function Card({ s, bubbles, cluster, onObserve, onProfile }: { s: Student; bubbles: Map<string, Bubble[]>; cluster?: string; onObserve: (id: string) => void; onProfile: (id: string) => void }) {
  return (
    <StudentCard
      id={s.id}
      name={s.learner?.name ?? `Student ${s.id}`}
      sessionId={s.session.id.toString()}
      stage={s.stage}
      turnState={s.session.turnState}
      bubbles={bubbles.get(s.session.id.toString()) ?? NO_BUBBLES}
      cluster={cluster}
      onObserve={onObserve}
      onProfile={onProfile}
    />
  );
}

function AllSessions({ order, students, clusterOf, onObserve, onProfile }: { order: string[]; students: Map<string, Student>; clusterOf: (id: string) => ClusterBlock | undefined; onObserve: (id: string) => void; onProfile: (id: string) => void }) {
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
                <button className="pr-secondary db-icon-btn" data-testid="open-profile-row" onClick={() => onProfile(id)} style={{ marginRight: 6 }}><ProfileIcon size={16} />Profile</button>
                <button className="pr-secondary db-icon-btn" data-testid="observe-student-row" onClick={() => onObserve(id)}><ObserveIcon size={16} />Observe</button>
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
            <span className="db-frame-icon"><ObserveIcon size={20} /></span>
            <Initial name={name} />
            <strong data-testid="observe-name">{name}</strong>
            <small>{[cluster?.name, student?.stage].filter(Boolean).join(' · ')} · summaries paused</small>
          </div>
          <div className="db-frame-nav">
            <span>{position + 1} / {total}</span>
            <button className="pr-secondary db-icon-btn" data-testid="observe-prev" onClick={() => onStep(-1)} disabled={total < 2}><PrevIcon size={16} />Previous</button>
            <button className="pr-secondary db-icon-btn" data-testid="observe-next" onClick={() => onStep(1)} disabled={total < 2}>Next<NextIcon size={16} /></button>
            <button className="pr-primary db-icon-btn" data-testid="observe-stop" onClick={onStop}><StopIcon size={16} /><span>Stop observing</span></button>
          </div>
        </div>
        <div className="db-frame-body">
          {student ? <SessionView key={student.session.id.toString()} conn={conn} sessionId={student.session.id} readOnly embedded /> : <p className="pr-note">This student left the class.</p>}
        </div>
      </div>
    </div>
  );
}
