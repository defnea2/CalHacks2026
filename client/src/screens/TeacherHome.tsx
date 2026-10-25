// Teacher flow: pick or create yourself (?teacher), set up and start a class session
// (?teacher=<id>), then the dashboard (?class=<id>). No accounts.
import { useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { ClassSession, Learner, Presence, Teacher } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { APP_CONFIG } from '../app-config';
import { navigate, routeUrl } from '../lib/format';
import { DOC_ACCEPT, NO_DOCUMENT, readClassDocument, type ClassDocument } from '../lib/classDocument';
import { eventLog } from '../lib/debug';
import { Initial } from './StudentHome';

export const MAX_SIMULATED = 20;

export function TeacherHome({ conn }: { conn: DbConnection }) {
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const sub = subscribe(conn, ['SELECT * FROM teacher', 'SELECT * FROM class_session WHERE active = true'], 'teachers');
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn]);
  const teachers = useRows<Teacher>(conn.db.teacher, () => true, []).sort((a, b) => Number(a.id - b.id));
  const running = useRows<ClassSession>(conn.db.classSession, c => c.active, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const args = { name: name.trim() };
    const r = await callReducer('createTeacher', args, () => conn.reducers.createTeacher(args));
    setBusy(false);
    if (r.ok) setName('');
    else setError(r.error ?? 'failed');
  };

  return (
    <div data-testid="teacher-home">
      <a className="pr-back" href={routeUrl()} onClick={e => { e.preventDefault(); navigate(routeUrl()); }}>← Back</a>
      <section className="pr-intro" style={{ paddingTop: 22 }}>
        <span className="pr-eyebrow">Teacher</span>
        <h1>Welcome, teacher.</h1>
        <p>Pick your name or add yourself, then set up today's class.</p>
      </section>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      <div className="pr-split">
        <div>
          <div className="pr-section-label"><h2>Teachers</h2><span>{teachers.length}</span></div>
          <div className="pr-people" data-testid="teacher-list">
            {teachers.length === 0 && <p className="pr-empty">No teachers yet. Add yourself on the right.</p>}
            {teachers.map(t => {
              const live = running.some(c => c.teacherId === t.id);
              return (
                <button key={t.id.toString()} className="pr-person" data-testid="teacher-item" data-teacher-id={t.id.toString()} data-teacher-name={t.name} onClick={() => navigate(routeUrl({ teacher: t.id }))}>
                  <Initial name={t.name} />
                  <span>
                    <strong>{t.name}</strong>
                    <small>{live ? 'Class running' : 'No class running'}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <form className="pr-panel pr-form" data-testid="create-teacher-form" onSubmit={create}>
          <h2>Add yourself</h2>
          <label className="pr-field">
            <span>Your name</span>
            <input data-testid="create-teacher-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ms. Park" required />
          </label>
          <button className="pr-primary" data-testid="create-teacher-submit" disabled={busy || !name.trim()}>
            <span>{busy ? 'Adding…' : 'Add me'}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </div>
  );
}

export function ClassSetup({ conn, teacherId }: { conn: DbConnection; teacherId: bigint }) {
  const [error, setError] = useState('');
  useEffect(() => {
    const sub = subscribe(
      conn,
      [
        `SELECT * FROM teacher WHERE id = ${teacherId}`,
        `SELECT * FROM class_session WHERE teacher_id = ${teacherId}`,
        // Only online students (the waiting / in-session counts) and their learner rows.
        "SELECT * FROM presence WHERE status = 'waiting'",
        "SELECT * FROM presence WHERE status = 'in_session'",
        "SELECT l.* FROM learner l JOIN presence p ON l.id = p.learner_id WHERE p.status = 'waiting'",
        "SELECT l.* FROM learner l JOIN presence p ON l.id = p.learner_id WHERE p.status = 'in_session'",
      ],
      `class setup ${teacherId}`
    );
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn, teacherId]);
  const teacher = useRows<Teacher>(conn.db.teacher, t => t.id === teacherId, [teacherId])[0];
  const classes = useRows<ClassSession>(conn.db.classSession, c => c.teacherId === teacherId, [teacherId]);
  const running = classes.filter(c => c.active).sort((a, b) => Number(b.id - a.id))[0];
  const learners = useRows<Learner>(conn.db.learner, () => true, []);
  const presence = useRows<Presence>(conn.db.presence, () => true, []);
  const real = new Set(learners.filter(l => !l.isSimulated).map(l => l.id));
  const waiting = presence.filter(p => real.has(p.learnerId) && p.status === 'waiting').length;
  const inSession = presence.filter(p => real.has(p.learnerId) && p.status === 'in_session').length;

  const [goals, setGoals] = useState('');
  const [content, setContent] = useState('');
  const [delivery, setDelivery] = useState('');
  const [doc, setDoc] = useState<ClassDocument>(NO_DOCUMENT);
  const [docBusy, setDocBusy] = useState(false);
  const [simulated, setSimulated] = useState(8);
  const [resetSim, setResetSim] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetState, setResetState] = useState<'' | 'busy' | 'done'>('');
  const [busy, setBusy] = useState(false);
  const [startedAfter, setStartedAfter] = useState<bigint | null>(null);

  // After startClassSession the new active class session arrives through the subscription.
  const fresh = startedAfter === null ? undefined : classes.find(c => c.active && c.id > startedAfter);
  const handled = useRef(false);
  useEffect(() => {
    if (!fresh || handled.current) return;
    handled.current = true;
    navigate(routeUrl({ class: fresh.id }));
  }, [fresh]);

  const pickDoc = async (file: File | undefined) => {
    setError('');
    if (!file) {
      setDoc(NO_DOCUMENT);
      return;
    }
    setDocBusy(true);
    try {
      setDoc(await readClassDocument(file, APP_CONFIG.photoMaxBytes, APP_CONFIG.photoMaxSide));
    } catch (err) {
      setDoc(NO_DOCUMENT);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDocBusy(false);
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goals.trim() && !content.trim()) {
      setError('Add a learning goal or the content to cover.');
      return;
    }
    setBusy(true);
    setError('');
    const args = {
      teacherId,
      goals: goals.trim(),
      content: content.trim(),
      delivery: delivery.trim(),
      documentName: doc.name,
      documentMime: doc.mime,
      documentText: doc.text,
      documentData: doc.data,
      simulatedCount: Math.max(0, Math.min(MAX_SIMULATED, simulated)),
      resetSimulated: resetSim,
    };
    setStartedAfter(classes.reduce((m, c) => (c.id > m ? c.id : m), 0n));
    eventLog.log('ui.start_class', { simulated: args.simulatedCount, reset: resetSim, document: doc.mime });
    const r = await callReducer('startClassSessionWith', args, () => conn.reducers.startClassSessionWith(args));
    if (!r.ok) {
      setStartedAfter(null);
      setBusy(false);
      setError(r.error ?? 'failed');
    }
  };

  /** All 20 simulated students back to their seed memories (refused while a class is running). */
  const resetAll = async () => {
    setConfirmReset(false);
    setResetState('busy');
    setError('');
    const args = { count: 0 };
    const r = await callReducer('resetSimulatedStudents', args, () => conn.reducers.resetSimulatedStudents(args));
    setResetState(r.ok ? 'done' : '');
    if (!r.ok) setError(r.error ?? 'failed');
  };

  return (
    <div data-testid="class-setup" data-teacher-id={teacherId.toString()}>
      <a className="pr-back" href={routeUrl({ teacher: '' })} onClick={e => { e.preventDefault(); navigate(routeUrl({ teacher: '' })); }}>← Not you?</a>
      <section className="pr-intro" style={{ paddingTop: 22 }}>
        <span className="pr-eyebrow">{teacher?.name ?? 'Teacher'}</span>
        <h1>Set up today's class</h1>
        <p>The tutor follows your goals and your way of teaching with every student. Starting the class brings every student who is online into it.</p>
      </section>
      {running && (
        <div className="pr-running" data-testid="class-running">
          <span>Your class is running since {new Date(Number(running.startedAt.microsSinceUnixEpoch / 1000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Starting a new one ends it.</span>
          <button className="pr-secondary" data-testid="open-dashboard" onClick={() => navigate(routeUrl({ class: running.id }))}>Open dashboard →</button>
        </div>
      )}
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      <form className="pr-setup" onSubmit={start} data-testid="class-form">
        <div className="pr-form">
          <label className="pr-field">
            <span>Learning goals</span>
            <textarea data-testid="class-goals" rows={3} value={goals} onChange={e => setGoals(e.target.value)} placeholder="e.g. Students can find equivalent fractions and explain why they are equal." />
          </label>
          <label className="pr-field">
            <span>Content to cover</span>
            <textarea data-testid="class-content" rows={3} value={content} onChange={e => setContent(e.target.value)} placeholder="e.g. Equivalent fractions with denominators up to 12; expand 2/3 to twelfths." />
          </label>
          <label className="pr-field">
            <span>How to teach</span>
            <textarea data-testid="class-delivery" rows={3} value={delivery} onChange={e => setDelivery(e.target.value)} placeholder="e.g. Start with fraction bars, let them try first, never give the answer away." />
            <small>The tutor treats these as binding instructions.</small>
          </label>
          <label className="pr-field">
            <span>Material <small>(optional: a worksheet photo, Markdown or text)</small></span>
            <input data-testid="class-document" className="pr-file" type="file" accept={DOC_ACCEPT} onChange={e => void pickDoc(e.target.files?.[0])} />
            {(docBusy || doc.note) && <small data-testid="class-document-state">{docBusy ? 'Reading…' : `${doc.name} · ${doc.note}`}</small>}
          </label>
        </div>
        <aside className="pr-setup-side">
          <div className="pr-panel">
            <h2>Students online</h2>
            <div className="pr-online" data-testid="online-count" data-waiting={waiting} data-in-session={inSession}>
              <span><strong>{waiting}</strong>waiting</span>
              <span><strong>{inSession}</strong>in a lesson</span>
            </div>
            <p className="pr-note" style={{ marginTop: 10, marginBottom: 0 }}>They all join when you start.</p>
          </div>
          <div className="pr-panel">
            <h2>Simulated students</h2>
            <div className="pr-count">
              <input data-testid="sim-count-range" type="range" min={0} max={MAX_SIMULATED} step={1} value={simulated} onChange={e => setSimulated(Number(e.target.value))} aria-label="Number of simulated students" />
              <output data-testid="sim-count" data-value={simulated}>{simulated}</output>
            </div>
            <p className="pr-note" style={{ margin: '10px 0 0' }}>
              AI students with their own personalities and memories, typing to the tutor. The dashboard groups students in twos or fours, so an even number works best.
              {simulated % 2 === 1 && <strong data-testid="sim-odd"> With an odd number one group has three.</strong>}
            </p>
            <label className="pr-check" style={{ marginTop: 10 }}>
              <input data-testid="sim-reset" type="checkbox" checked={resetSim} onChange={e => setResetSim(e.target.checked)} />
              Reset simulated students (fresh memories)
            </label>
            <div className="pr-note" style={{ margin: '8px 0 0' }}>
              {confirmReset ? (
                <span data-testid="sim-reset-ask">
                  Reset all {MAX_SIMULATED} to fresh memories?{' '}
                  <button type="button" className="pr-secondary" data-testid="sim-reset-confirm" onClick={() => void resetAll()}>Yes, reset</button>{' '}
                  <button type="button" className="pr-secondary" data-testid="sim-reset-cancel" onClick={() => setConfirmReset(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="pr-secondary" data-testid="sim-reset-button" disabled={resetState === 'busy'} onClick={() => { setResetState(''); setConfirmReset(true); }}>
                  {resetState === 'busy' ? 'Resetting…' : resetState === 'done' ? 'Simulated students reset ✓' : 'Reset simulated students'}
                </button>
              )}
            </div>
          </div>
          <button className="pr-primary" data-testid="start-class" disabled={busy || docBusy}>
            <span>{busy ? 'Starting…' : 'Start class session'}</span>
            <span aria-hidden="true">→</span>
          </button>
        </aside>
      </form>
    </div>
  );
}
