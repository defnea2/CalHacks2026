// Screen 1: pick a user (lists learners, creates test users, reopens or starts a session).
import { useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Session } from '../module_bindings/types';
import { callReducer, subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { Badge, Button, Card, CardHeader, ErrorNote, Input, Label, Textarea } from '../components/ui';
import { APP_CONFIG } from '../app-config';
import { navigate, phaseLabel, sessionUrl } from '../lib/format';
import { compressPhoto } from '../lib/photo';
import { eventLog } from '../lib/debug';

export function PickUser({ conn }: { conn: DbConnection }) {
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Learner | null>(null);

  useEffect(() => {
    const sub = subscribe(conn, ['SELECT * FROM learner', 'SELECT * FROM session WHERE active = true'], 'pick-user');
    sub.ready.catch(e => setError(String(e?.message ?? e)));
    return () => sub.unsubscribe();
  }, [conn]);

  const learners = useRows<Learner>(conn.db.learner, () => true, []).sort((a, b) => Number(a.id - b.id));
  const active = useRows<Session>(conn.db.session, s => s.active, []);
  const activeFor = (l: Learner) => active.find(s => s.learnerId === l.id);

  const choose = (l: Learner) => {
    const s = activeFor(l);
    eventLog.log('ui.pick_learner', { learnerId: l.id.toString(), activeSession: s?.id.toString() ?? '' });
    if (s) navigate(sessionUrl('session', s.id));
    else setPicked(l);
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Who is learning today?</h1>
          <p className="text-sm text-muted-foreground">{APP_CONFIG.pageDescription} Test users only.</p>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Card>
          <CardHeader title="Learners">
            <span className="text-xs text-muted-foreground">{learners.length}</span>
          </CardHeader>
          <ul data-testid="learner-list" className="divide-y">
            {learners.length === 0 ? <li className="px-4 py-6 text-sm text-muted-foreground">No learners yet. Create a test user.</li> : null}
            {learners.map(l => {
              const s = activeFor(l);
              return (
                <li key={l.id.toString()} className="flex items-center justify-between gap-3 px-4 py-3">
                  <button
                    data-testid="learner-item"
                    data-learner-id={l.id.toString()}
                    data-learner-name={l.name}
                    onClick={() => choose(l)}
                    className="flex flex-1 flex-col items-start text-left"
                  >
                    <span className="font-medium">{l.name}</span>
                    <span className="text-xs text-muted-foreground">
                      Age {l.age} · Grade {l.grade}
                      {l.style ? ` · ${l.style}` : ''}
                    </span>
                  </button>
                  {s ? (
                    <div className="flex items-center gap-2">
                      <Badge data-testid="learner-active-session">Active · {s.code || s.id.toString()} · {phaseLabel(s.phase)}</Badge>
                      <Button size="sm" variant="ghost" data-testid="learner-new-session" onClick={() => setPicked(l)}>
                        New
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
      <div className="flex flex-col gap-6">
        {picked ? (
          <StartForm conn={conn} learner={picked} previous={activeFor(picked)} active={active} onCancel={() => setPicked(null)} />
        ) : null}
        <CreateUserForm conn={conn} />
      </div>
    </div>
  );
}

function CreateUserForm({ conn }: { conn: DbConnection }) {
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
    <Card>
      <CardHeader title="Create a test user" />
      <form data-testid="create-user-form" onSubmit={submit} className="flex flex-col gap-3 p-4">
        <Label>
          Name
          <Input data-testid="create-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mia" required />
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Label>
            Age
            <Input data-testid="create-age" type="number" min={5} max={16} value={age} onChange={e => setAge(e.target.value)} />
          </Label>
          <Label>
            Grade
            <Input data-testid="create-grade" type="number" min={1} max={12} value={grade} onChange={e => setGrade(e.target.value)} />
          </Label>
        </div>
        <Label>
          Learning style
          <Input data-testid="create-style" value={style} onChange={e => setStyle(e.target.value)} />
        </Label>
        <ErrorNote>{error}</ErrorNote>
        <Button data-testid="create-submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create test user'}
        </Button>
      </form>
    </Card>
  );
}

function StartForm({
  conn,
  learner,
  previous,
  active,
  onCancel,
}: {
  conn: DbConnection;
  learner: Learner;
  previous: Session | undefined;
  active: Session[];
  onCancel: () => void;
}) {
  const [task, setTask] = useState(APP_CONFIG.defaultTaskText);
  const [photo, setPhoto] = useState<File | null>(null);
  /** Text mode (session.voice = false): no microphone, no tutor audio; the lesson plays as text. */
  const [typing, setTyping] = useState(() => new URLSearchParams(window.location.search).get('voice') === '0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  // After startSession: the learner's new active session shows up through the subscription.
  // `previous` changes once the new session is active, so remember the one we replaced.
  const [replaced, setReplaced] = useState<bigint | null>(null);
  const fresh = waitingSince === null ? undefined : active.find(s => s.learnerId === learner.id && s.id !== replaced);
  const handled = useRef(false);
  useEffect(() => {
    if (waitingSince === null || !fresh || handled.current) return;
    handled.current = true;
    void (async () => {
      if (typing) {
        const args = { sessionId: fresh.id, voice: false };
        const r = await callReducer('setSessionVoice', args, () => conn.reducers.setSessionVoice(args));
        if (!r.ok) eventLog.log('ui.text_mode_failed', { error: r.error });
      }
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
      navigate(sessionUrl('session', fresh.id));
    })();
  }, [fresh, waitingSince, photo, typing, conn]);

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
    <Card data-testid="start-form">
      <CardHeader title={`Start a session for ${learner.name}`}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </CardHeader>
      <form onSubmit={start} className="flex flex-col gap-3 p-4">
        <Label>
          The task you are stuck on
          <Textarea data-testid="task-text" rows={3} value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. Expand 2/3 so the bottom number is 12." />
        </Label>
        <Label>
          Photo of the task (optional)
          <input data-testid="photo-input" type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} className="text-sm" />
        </Label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input data-testid="text-mode" type="checkbox" checked={typing} onChange={e => setTyping(e.target.checked)} />
          Type instead of talking (no sound)
        </label>
        {previous && waitingSince === null ? <p className="text-xs text-muted-foreground">This ends the active session {previous.code || previous.id.toString()}.</p> : null}
        <ErrorNote>{error}</ErrorNote>
        <Button data-testid="start-session" disabled={busy}>
          {busy ? 'Starting…' : 'Start session'}
        </Button>
      </form>
    </Card>
  );
}
