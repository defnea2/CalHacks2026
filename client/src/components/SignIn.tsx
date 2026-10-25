// Passwordless sign-in UI (docs/ARCHITECTURE.md "Identity and authorization"):
// - CodeForm: "I have a code" -> linkDevice links this device to the code's account.
// - DeviceCode: a one-time code (+ link) to sign this account in on another device.
// - StudentRoster: the teacher's students, "Add student", a code per student for their device.
// - ClaimLegacy: accounts from before sign-in existed, claimable once.
import { useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Teacher } from '../module_bindings/types';
import { formatCode, type AccountKind, type IssueCodeResult } from '@tutor/shared/auth';
import { callReducer, subscribe } from '../stdb/connection';
import { useAccounts } from '../stdb/useAccounts';
import { useRows } from '../stdb/useRows';
import { navigate, routeUrl } from '../lib/format';
import { eventLog } from '../lib/debug';
import { QrCode } from './QrCode';

/** URL a code can be opened with (QR): the entry page fills it into the code form. */
export function codeUrl(code: string): string {
  const u = new URL(window.location.href);
  u.search = `?code=${encodeURIComponent(code)}`;
  return u.toString();
}

function codeFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('code') ?? '';
  } catch {
    return '';
  }
}

type LinkResult = { ok: true; kind: AccountKind; accountId: string; name: string } | { ok: false; error: string };

export async function redeemCode(conn: DbConnection, code: string): Promise<LinkResult> {
  eventLog.log('procedure.call', { name: 'linkDevice' });
  try {
    return JSON.parse(await conn.procedures.linkDevice({ code })) as LinkResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function CodeForm({ conn, kind }: { conn: DbConnection; kind?: AccountKind }) {
  const [code, setCode] = useState(codeFromUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    const r = await redeemCode(conn, code);
    setBusy(false);
    eventLog.log('ui.link_device', { ok: r.ok, kind: r.ok ? r.kind : '' });
    if (!r.ok) return setError(r.error);
    setCode('');
    navigate(routeUrl(r.kind === 'learner' ? { student: BigInt(r.accountId) } : { teacher: BigInt(r.accountId) }));
  };
  return (
    <form className="pr-panel pr-form" data-testid="code-form" onSubmit={submit} style={{ marginTop: 18 }}>
      <h2>I have a code</h2>
      <p className="pr-note" style={{ margin: 0 }}>
        {kind === 'learner'
          ? 'Your teacher gives you a code to sign in on this device.'
          : kind === 'teacher'
            ? 'Get a sign-in code on the device where you are already signed in.'
            : 'Students get a code from their teacher; teachers make one on the device they already use.'}
      </p>
      <label className="pr-field">
        <span>Code</span>
        <input data-testid="code-input" value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. K7Q-2M9" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} />
      </label>
      {error && <p className="pr-error" data-testid="code-error">{error}</p>}
      <button className="pr-secondary" data-testid="code-submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Sign in with code'}</button>
    </form>
  );
}

async function issue(conn: DbConnection, kind: AccountKind, accountId: bigint, teacherId: bigint): Promise<IssueCodeResult> {
  eventLog.log('procedure.call', { name: 'issueSignInCode', kind, accountId: accountId.toString() });
  try {
    return JSON.parse(await conn.procedures.issueSignInCode({ kind, accountId, teacherId })) as IssueCodeResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function minutesLeft(expiresMs: number): string {
  const m = Math.max(0, Math.round((expiresMs - Date.now()) / 60_000));
  return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`;
}

function CodeCard({ result, onClose }: { result: Extract<IssueCodeResult, { ok: true }>; onClose: () => void }) {
  return (
    <div className="pr-code-card" data-testid="code-card" data-code={result.code}>
      <QrCode text={codeUrl(result.code)} size={132} />
      <div>
        <strong className="pr-code" data-testid="code-value">{formatCode(result.code)}</strong>
        <p className="pr-note" style={{ margin: '6px 0' }}>
          For {result.name}. Type it under “I have a code” or scan the picture. Works once, for {minutesLeft(result.expiresMs)}.
        </p>
        <button type="button" className="pr-secondary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** "Sign in on another device": a code for an account this device owns. */
export function DeviceCode({ conn, kind, accountId }: { conn: DbConnection; kind: AccountKind; accountId: bigint }) {
  const [result, setResult] = useState<IssueCodeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const get = async () => {
    setBusy(true);
    setResult(await issue(conn, kind, accountId, 0n));
    setBusy(false);
  };
  return (
    <div className="pr-panel pr-form" data-testid="device-code">
      <h2>Sign in on another device</h2>
      <p className="pr-note" style={{ margin: 0 }}>No password: this device makes a one-time code for the other one.</p>
      {result?.ok ? (
        <CodeCard result={result} onClose={() => setResult(null)} />
      ) : (
        <button type="button" className="pr-secondary" data-testid="device-code-get" disabled={busy} onClick={() => void get()}>{busy ? 'Making a code…' : 'Get a sign-in code'}</button>
      )}
      {result && !result.ok && <p className="pr-error" data-testid="device-code-error">{result.error}</p>}
    </div>
  );
}

/** The teacher's students (added here or from past classes) with "Add student" and a code each. */
export function StudentRoster({ conn, teacherId }: { conn: DbConnection; teacherId: bigint }) {
  const acc = useAccounts(conn);
  const ids = new Set(acc.roster.filter(r => r.teacherId === teacherId).map(r => r.learnerId));
  const students = acc.students.filter(l => ids.has(l.id));
  const [codes, setCodes] = useState<Record<string, IssueCodeResult>>({});
  const [name, setName] = useState('');
  const [age, setAge] = useState('9');
  const [grade, setGrade] = useState('4');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    const args = { teacherId, name: name.trim(), age: Number(age) || 0, grade: Number(grade) || 0, style: '' };
    const r = await callReducer('addStudent', args, () => conn.reducers.addStudent(args));
    setBusy(false);
    if (r.ok) setName('');
    else setError(r.error ?? 'failed');
  };
  const getCode = async (l: Learner) => {
    const r = await issue(conn, 'learner', l.id, teacherId);
    setCodes(c => ({ ...c, [l.id.toString()]: r }));
  };

  return (
    <div className="pr-panel pr-form" data-testid="student-roster">
      <h2>My students <small>({students.length})</small></h2>
      <p className="pr-note" style={{ margin: 0 }}>Each child signs in once on their own device with a code from you. Students who joined one of your classes are listed too.</p>
      <div className="pr-people">
        {students.map(l => {
          const c = codes[l.id.toString()];
          return (
            <div key={l.id.toString()} className="pr-roster-row" data-testid="roster-item" data-learner-name={l.name}>
              <span><strong>{l.name}</strong> <small>Age {l.age} · Grade {l.grade}</small></span>
              {c?.ok ? (
                <CodeCard result={c} onClose={() => setCodes(x => ({ ...x, [l.id.toString()]: undefined as never }))} />
              ) : (
                <button type="button" className="pr-secondary" data-testid="roster-code" onClick={() => void getCode(l)}>Code for their device</button>
              )}
              {c && !c.ok && <p className="pr-error">{c.error}</p>}
            </div>
          );
        })}
      </div>
      <form onSubmit={add} data-testid="add-student-form" className="pr-row" style={{ alignItems: 'flex-end' }}>
        <label className="pr-field"><span>Add student</span><input data-testid="add-student-name" value={name} onChange={e => setName(e.target.value)} placeholder="First name" /></label>
        <label className="pr-field" style={{ maxWidth: 80 }}><span>Age</span><input type="number" min={5} max={18} value={age} onChange={e => setAge(e.target.value)} /></label>
        <label className="pr-field" style={{ maxWidth: 80 }}><span>Grade</span><input type="number" min={0} max={13} value={grade} onChange={e => setGrade(e.target.value)} /></label>
        <button className="pr-secondary" data-testid="add-student-submit" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add'}</button>
      </form>
      {error && <p className="pr-error">{error}</p>}
    </div>
  );
}

/** Accounts created before sign-in existed: claimable once by the first device (then gone). */
export function ClaimLegacy({ conn, kind }: { conn: DbConnection; kind: AccountKind }) {
  const table = kind === 'learner' ? 'claimable_learners' : 'claimable_teachers';
  useEffect(() => {
    const sub = subscribe(conn, [`SELECT * FROM ${table}`], table);
    return () => sub.unsubscribe();
  }, [conn, table]);
  const rows = useRows<Learner | Teacher>(kind === 'learner' ? conn.db.claimableLearners : conn.db.claimableTeachers, () => true, [kind]).sort((a, b) => Number(a.id - b.id));
  const [error, setError] = useState('');
  if (!rows.length) return null;
  const claim = async (r: Learner | Teacher) => {
    setError('');
    const args = { kind, accountId: r.id };
    const res = await callReducer('claimAccount', args, () => conn.reducers.claimAccount(args));
    if (!res.ok) return setError(res.error ?? 'failed');
    navigate(routeUrl(kind === 'learner' ? { student: r.id } : { teacher: r.id }));
  };
  return (
    <details className="pr-legacy" data-testid="claim-legacy" style={{ marginTop: 18 }}>
      <summary>Accounts from before sign-in ({rows.length})</summary>
      <p className="pr-note">These were made before devices signed in. The first device that picks one keeps it.</p>
      <div className="pr-people">
        {rows.map(r => (
          <button key={r.id.toString()} className="pr-person" data-testid="claim-item" data-name={r.name} onClick={() => void claim(r)}>
            <span><strong>{r.name}</strong><small>Claim for this device</small></span>
          </button>
        ))}
      </div>
      {error && <p className="pr-error">{error}</p>}
    </details>
  );
}
