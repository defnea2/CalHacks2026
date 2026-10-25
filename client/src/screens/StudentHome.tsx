// Student flow: pick or create yourself (?student), then choose how to learn (?student=<id>):
// "Learn by myself" (task text + optional photo → own session) or "Wait for my teacher"
// (?wait=<id>, joins the class session automatically).
import { useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Session } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { APP_CONFIG } from '../app-config';
import { navigate, phaseLabel, routeUrl, sessionUrl } from '../lib/format';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';

export function Initial({ name }: { name: string }) {
  return <span className="pr-initial" aria-hidden="true">{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}

export function StudentHome({ conn }: { conn: DbConnection }) {
  const [error, setError] = useState('');
  useEffect(() => {
    const sub = subscribe(conn, ['SELECT * FROM learner'], 'students');
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn]);
  // Simulated classroom students are real rows but belong to the teacher's simulation.
  const learners = useRows<Learner>(conn.db.learner, l => !l.isSimulated, []).sort((a, b) => Number(a.id - b.id));

  const choose = (l: Learner) => {
    eventLog.log('ui.pick_learner', { learnerId: l.id.toString() });
    navigate(routeUrl({ student: l.id }));
  };

  return (
    <div data-testid="student-home">
      <a className="pr-back" href={routeUrl()} onClick={e => { e.preventDefault(); navigate(routeUrl()); }}>← Back</a>
      <section className="pr-intro" style={{ paddingTop: 22 }}>
        <span className="pr-eyebrow">Student</span>
        <h1>Who is learning today?</h1>
        <p>Pick your name, or add yourself. No password needed.</p>
      </section>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      <div className="pr-split">
        <div>
          <div className="pr-section-label"><h2>Students</h2><span>{learners.length}</span></div>
          <div className="pr-people" data-testid="learner-list">
            {learners.length === 0 && <p className="pr-empty">No students yet. Add yourself on the right.</p>}
            {learners.map(l => (
              <button key={l.id.toString()} className="pr-person" data-testid="learner-item" data-learner-id={l.id.toString()} data-learner-name={l.name} onClick={() => choose(l)}>
                <Initial name={l.name} />
                <span>
                  <strong>{l.name}</strong>
                  <small>Age {l.age} · Grade {l.grade}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <CreateLearnerForm conn={conn} />
      </div>
    </div>
  );
}

function CreateLearnerForm({ conn }: { conn: DbConnection }) {
  const [name, setName] = useState('');
  const [age, setAge] = useState('9');
  const [grade, setGrade] = useState('4');
  const [style, setStyle] = useState('short hints, visuals first');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    const args = { name: name.trim(), age: Number(age) || 0, grade: Number(grade) || 0, style: style.trim() };
    const r = await callReducer('createTestUser', args, () => conn.reducers.createTestUser(args));
    setBusy(false);
    if (r.ok) setName('');
    else setError(r.error ?? 'failed');
  };

  return (
    <form className="pr-panel pr-form" data-testid="create-user-form" onSubmit={submit}>
      <h2>Add yourself</h2>
      <label className="pr-field">
        <span>Your name</span>
        <input data-testid="create-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mia" required />
      </label>
      <div className="pr-row">
        <label className="pr-field">
          <span>Age</span>
          <input data-testid="create-age" type="number" min={5} max={16} value={age} onChange={e => setAge(e.target.value)} />
        </label>
        <label className="pr-field">
          <span>Grade</span>
          <input data-testid="create-grade" type="number" min={1} max={12} value={grade} onChange={e => setGrade(e.target.value)} />
        </label>
      </div>
      <label className="pr-field">
        <span>How you like to learn</span>
        <input data-testid="create-style" value={style} onChange={e => setStyle(e.target.value)} />
      </label>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      <button className="pr-primary" data-testid="create-submit" disabled={busy || !name.trim()}>
        <span>{busy ? 'Adding…' : 'Add me'}</span>
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}

export function StudentStart({ conn, learnerId }: { conn: DbConnection; learnerId: bigint }) {
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'self' | null>(null);
  useEffect(() => {
    const id = learnerId.toString();
    const sub = subscribe(conn, [`SELECT * FROM learner WHERE id = ${id}`, `SELECT * FROM session WHERE learner_id = ${id}`], `student ${id}`);
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn, learnerId]);
  const learner = useRows<Learner>(conn.db.learner, l => l.id === learnerId, [learnerId])[0];
  const active = useRows<Session>(conn.db.session, s => s.learnerId === learnerId && s.active, [learnerId]);
  const current = active.sort((a, b) => Number(b.id - a.id))[0];

  return (
    <div data-testid="student-start" data-learner-id={learnerId.toString()}>
      <a className="pr-back" href={routeUrl({ student: '' })} onClick={e => { e.preventDefault(); navigate(routeUrl({ student: '' })); }}>← Not you?</a>
      <section className="pr-intro" style={{ paddingTop: 22 }}>
        <span className="pr-eyebrow">Student</span>
        <h1>Hi {learner?.name ?? '…'}! How do you want to learn?</h1>
      </section>
      {error && <p className="pr-error" data-testid="error">{error}</p>}
      {current && (
        <div className="pr-continue">
          <span>You have a lesson going: <strong>{current.taskText || 'your question'}</strong> · {phaseLabel(current.phase)}</span>
          <button className="pr-secondary" data-testid="learner-active-session" onClick={() => navigate(sessionUrl('session', current.id))}>Continue →</button>
        </div>
      )}
      <div className="pr-options" role="list">
        <button role="listitem" className="pr-option" aria-pressed={mode === 'self'} data-testid="mode-self" onClick={() => setMode('self')}>
          <span className="pr-option-top"><span>On my own</span><span>Now</span></span>
          <svg viewBox="0 0 260 110" className="pr-sketch" aria-hidden="true">
            {[2, 4].map((parts, row) => <g key={parts}>{Array.from({ length: parts }, (_, i) => <rect key={i} x={30 + i * 200 / parts} y={18 + row * 46} width={200 / parts} height="28" fill={i < parts / 2 ? '#d3e2d9' : '#fffefa'} stroke="#24594b" />)}</g>)}
          </svg>
          <h2>Learn by myself</h2>
          <p>Tell the tutor what you're stuck on, add a photo if you like, and start right away.</p>
          <span className="pr-option-link"><span>Describe your task</span><span aria-hidden="true">↓</span></span>
        </button>
        <button role="listitem" className="pr-option" data-testid="mode-wait" onClick={() => navigate(routeUrl({ wait: learnerId }))}>
          <span className="pr-option-top"><span>With my class</span><span>When it starts</span></span>
          <svg viewBox="0 0 260 110" className="pr-sketch" aria-hidden="true">
            <circle cx="130" cy="55" r="34" fill="none" stroke="#24594b" strokeWidth="1.6" />
            <path d="M130 55V33 M130 55l16 10" stroke="#b8723f" strokeWidth="2.4" strokeLinecap="round" />
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => <path key={i} d={`M${130 + 30 * Math.sin((i * Math.PI) / 6)} ${55 - 30 * Math.cos((i * Math.PI) / 6)}l${2 * Math.sin((i * Math.PI) / 6)} ${-2 * Math.cos((i * Math.PI) / 6)}`} stroke="#657168" strokeWidth="1.5" />)}
          </svg>
          <h2>Wait for my teacher</h2>
          <p>Your lesson opens by itself as soon as your teacher starts the class.</p>
          <span className="pr-option-link"><span>Go to the waiting room</span><span aria-hidden="true">→</span></span>
        </button>
      </div>
      {mode === 'self' && learner && <StartForm conn={conn} learner={learner} previous={current} active={active} />}
    </div>
  );
}

function StartForm({ conn, learner, previous, active }: { conn: DbConnection; learner: Learner; previous: Session | undefined; active: Session[] }) {
  const [task, setTask] = useState(APP_CONFIG.defaultTaskText);
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => taskRef.current?.focus(), []);

  // After startSession the learner's new active session shows up through the subscription.
  const [replaced, setReplaced] = useState<bigint | null>(null);
  const fresh = waitingSince === null ? undefined : active.find(s => s.learnerId === learner.id && s.id !== replaced);
  const handled = useRef(false);
  useEffect(() => {
    if (waitingSince === null || !fresh || handled.current) return;
    handled.current = true;
    void (async () => {
      if (photo) {
        try {
          const c = await compressPhoto(photo, APP_CONFIG.photoMaxBytes, APP_CONFIG.photoMaxSide);
          const args = { sessionId: fresh.id, mime: c.mime, data: c.data };
          const r = await callReducer('uploadPhoto', args, () => conn.reducers.uploadPhoto(args));
          if (!r.ok) eventLog.log('ui.photo_failed', { error: r.error });
        } catch (err) {
          eventLog.log('ui.photo_failed', { error: String(err) });
        }
      }
      // The session screen turns on microphone + sound at once (this click is the user gesture).
      navigate(sessionUrl('session', fresh.id));
    })();
  }, [fresh, waitingSince, photo, conn]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const args = { learnerId: learner.id, taskText: task.trim() };
    setReplaced(previous?.id ?? null);
    setWaitingSince(Date.now());
    const r = await callReducer('startSession', args, () => conn.reducers.startSession(args));
    if (!r.ok) {
      setWaitingSince(null);
      setBusy(false);
      setError(r.error ?? 'failed');
    }
  };

  return (
    <form className="pr-start" data-testid="start-form" onSubmit={start}>
      <div className="pr-form">
        <label className="pr-field">
          <span>What are you stuck on?</span>
          <textarea ref={taskRef} data-testid="task-text" rows={4} value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. Expand 2/3 so the bottom number is 12." />
        </label>
        <label className="pr-field">
          <span>Photo of the task <small>(optional)</small></span>
          <input data-testid="photo-input" className="pr-file" type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="pr-form">
        <p className="pr-note">Your microphone and sound turn on when the lesson starts.</p>
        {previous && waitingSince === null ? <p className="pr-note">This ends your lesson {previous.code || previous.id.toString()}.</p> : null}
        {error && <p className="pr-error" data-testid="error">{error}</p>}
        <button className="pr-primary" data-testid="start-session" disabled={busy}>
          <span>{busy ? 'Starting…' : 'Start my lesson'}</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  );
}
