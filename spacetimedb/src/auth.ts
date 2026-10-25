// Identity and authorization (docs/ARCHITECTURE.md "Identity and authorization").
//
// Identity: every client keeps its SpacetimeDB token, so ctx.sender is a stable device identity.
// Accounts: a learner or teacher row is owned by the identities in account_link (the device that
// created it, plus devices that redeemed a one-time sign-in code). There are no passwords.
//
// Rules (every client reducer/procedure in index.ts calls one of the require* helpers first):
// - student reducers: only for a learner linked to the sender, and only for that learner's sessions;
// - teacher reducers: only for a teacher linked to the sender and that teacher's class sessions;
// - profiles / codes for a student: only a teacher of that student (teacher_student roster: added
//   by the teacher, or was in one of the teacher's class sessions);
// - simulated students: no identity; driven by module code only (a teacher starts/resets them);
// - the agent (worker or operator CLI holding AGENT_SECRET) is trusted and passes every check.
// Internal module paths (classroom simulation, scheduled jobs) call the functions behind the
// reducers directly and are not checked here.
import { SenderError, type ViewCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import { ACCOUNT_KINDS, AUTH_DEFAULTS as A, AUTH_ERRORS as E, normalizeCode, type AccountKind, type IssueCodeResult } from '../../shared/src/auth';
import { type Ctx, type PCtx, type S as Schema, type SessionRow, getSession, isAgent, onSessionUpdated, ts } from './ctx';
import { settings } from './env';
import { sha256Hex } from './sha256';

type LearnerRow = NonNullable<ReturnType<Ctx['db']['learner']['id']['find']>>;
type TeacherRow = NonNullable<ReturnType<Ctx['db']['teacher']['id']['find']>>;
type ClassRow = NonNullable<ReturnType<Ctx['db']['classSession']['id']['find']>>;

export const LEARNER: AccountKind = 'learner';
export const TEACHER: AccountKind = 'teacher';
const secs = (s: number) => BigInt(Math.round(s * 1_000_000));

// ================================================================ setup

/** init + connect: records when authorization was switched on (legacy-claim cutoff) and, the
 *  first time, backfills the teacher roster from existing class sessions. */
export function ensureAuthMeta(ctx: Ctx): void {
  if (ctx.db.authMeta.id.find(0)) return;
  ctx.db.authMeta.insert({ id: 0, enabledAt: ctx.timestamp });
  for (const s of ctx.db.session.iter()) {
    if (s.classSessionId === 0n) continue;
    const cls = ctx.db.classSession.id.find(s.classSessionId);
    if (cls) addToRoster(ctx, cls.teacherId, s.learnerId);
  }
}

function enabledAtMicros(ctx: Ctx): bigint {
  return ctx.db.authMeta.id.find(0)?.enabledAt.microsSinceUnixEpoch ?? 0n;
}

// ================================================================ links

export function isLinked(ctx: Ctx, kind: AccountKind, accountId: bigint, identity: Identity = ctx.sender): boolean {
  for (const l of ctx.db.accountLink.accountId.filter(accountId)) if (l.kind === kind && l.identity.isEqual(identity)) return true;
  return false;
}

function linkCount(ctx: Ctx, kind: AccountKind, accountId: bigint): number {
  let n = 0;
  for (const l of ctx.db.accountLink.accountId.filter(accountId)) if (l.kind === kind) n++;
  return n;
}

function link(ctx: Ctx, kind: AccountKind, accountId: bigint, via: 'created' | 'code' | 'claimed'): void {
  if (isLinked(ctx, kind, accountId)) return;
  ctx.db.accountLink.insert({ id: 0n, identity: ctx.sender, kind, accountId, via, createdAt: ctx.timestamp });
}

/** A client created an account: its device owns it. Accounts the agent creates (operator seed
 *  scripts) stay unowned and are handed out with sign-in codes. */
export function onAccountCreated(ctx: Ctx, kind: AccountKind, accountId: bigint): void {
  if (!isAgent(ctx)) link(ctx, kind, accountId, 'created');
}

export function addToRoster(ctx: Ctx, teacherId: bigint, learnerId: bigint): void {
  for (const r of ctx.db.teacherStudent.learnerId.filter(learnerId)) if (r.teacherId === teacherId) return;
  ctx.db.teacherStudent.insert({ id: 0n, teacherId, learnerId, createdAt: ctx.timestamp });
}

/** A session linked to a class session puts its learner on that teacher's roster. */
onSessionUpdated((ctx, prev, next) => {
  if (next.classSessionId === 0n || next.classSessionId === prev.classSessionId) return;
  const cls = ctx.db.classSession.id.find(next.classSessionId);
  if (cls) addToRoster(ctx, cls.teacherId, next.learnerId);
});

export function isTeacherOf(ctx: Ctx, teacherId: bigint, learnerId: bigint): boolean {
  for (const r of ctx.db.teacherStudent.learnerId.filter(learnerId)) if (r.teacherId === teacherId) return true;
  return false;
}

// ================================================================ checks

/** Scheduled reducers and procedures are client-callable in 2.13 (verified on the local server:
 *  a CLI call ran dashboard_tick). Only the scheduler (sender = the module's own identity) may run them. */
export function requireScheduler(ctx: { sender: Identity; identity: Identity }): void {
  if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError('scheduler only');
}

export function requireLearner(ctx: Ctx, learnerId: bigint): LearnerRow {
  const l = ctx.db.learner.id.find(learnerId);
  if (!l) throw new SenderError(`learner ${learnerId} not found`);
  if (isAgent(ctx)) return l;
  if (l.isSimulated) throw new SenderError(E.simulated);
  if (!isLinked(ctx, LEARNER, l.id)) throw new SenderError(E.learnerOtherDevice);
  return l;
}

export function requireTeacher(ctx: Ctx, teacherId: bigint): TeacherRow {
  const t = ctx.db.teacher.id.find(teacherId);
  if (!t) throw new SenderError(`teacher ${teacherId} not found`);
  if (isAgent(ctx)) return t;
  if (!isLinked(ctx, TEACHER, t.id)) throw new SenderError(E.teacherOtherDevice);
  return t;
}

/** Reducers that act on the shared simulation (no teacher id): any teacher account on this device. */
export function requireAnyTeacher(ctx: Ctx): void {
  if (isAgent(ctx)) return;
  for (const l of ctx.db.accountLink.identity.filter(ctx.sender)) if (l.kind === TEACHER && ctx.db.teacher.id.find(l.accountId)) return;
  throw new SenderError('teachers only: sign in as a teacher first');
}

/** The session's learner must be linked to the sender (student reducers on a session). */
export function requireSessionLearner(ctx: Ctx, sessionId: bigint): SessionRow {
  const s = getSession(ctx, sessionId);
  if (isAgent(ctx)) return s;
  const l = ctx.db.learner.id.find(s.learnerId);
  if (l?.isSimulated) throw new SenderError(E.simulated);
  if (!l || !isLinked(ctx, LEARNER, l.id)) throw new SenderError(E.sessionOtherDevice);
  return s;
}

export function requireClassTeacher(ctx: Ctx, classSessionId: bigint): ClassRow {
  const cls = ctx.db.classSession.id.find(classSessionId);
  if (!cls) throw new SenderError(`class session ${classSessionId} not found`);
  if (isAgent(ctx)) return cls;
  if (!isLinked(ctx, TEACHER, cls.teacherId)) throw new SenderError(E.classOtherTeacher);
  return cls;
}

/** Sender owns `teacherId` and the learner is that teacher's student. */
export function requireTeacherOf(ctx: Ctx, teacherId: bigint, learnerId: bigint): LearnerRow {
  requireTeacher(ctx, teacherId);
  const l = ctx.db.learner.id.find(learnerId);
  if (!l) throw new SenderError(`learner ${learnerId} not found`);
  if (!isAgent(ctx) && !isTeacherOf(ctx, teacherId, learnerId)) throw new SenderError(E.notYourStudent);
  return l;
}

// ================================================================ accounts

/** Pre-existing (legacy) accounts created before authorization was switched on and never linked:
 *  the first identity that claims one owns it. Everything newer needs a sign-in code. */
function isClaimable(kind: AccountKind, row: { createdAt: { microsSinceUnixEpoch: bigint } }, enabledAt: bigint, links: Iterable<{ kind: string }>): boolean {
  if (row.createdAt.microsSinceUnixEpoch >= enabledAt) return false;
  for (const l of links) if (l.kind === kind) return false;
  return true;
}

export function claimAccount(ctx: Ctx, kindRaw: string, accountId: bigint): void {
  const kind = parseKind(kindRaw);
  const row = kind === LEARNER ? ctx.db.learner.id.find(accountId) : ctx.db.teacher.id.find(accountId);
  if (!row) throw new SenderError(`${kind} ${accountId} not found`);
  if (kind === LEARNER && (row as LearnerRow).isSimulated) throw new SenderError(E.simulated);
  if (isLinked(ctx, kind, accountId)) return;
  if (!isClaimable(kind, row, enabledAtMicros(ctx), ctx.db.accountLink.accountId.filter(accountId))) {
    throw new SenderError(kind === LEARNER ? E.learnerOtherDevice : E.teacherOtherDevice);
  }
  link(ctx, kind, accountId, 'claimed');
}

/** "Sign out on this device": drops the sender's link. Refused for the last device of a
 *  teacher, or of a student without a teacher (nobody could issue a code to get it back). */
export function forgetAccount(ctx: Ctx, kindRaw: string, accountId: bigint): void {
  const kind = parseKind(kindRaw);
  const mine = [...ctx.db.accountLink.accountId.filter(accountId)].find(l => l.kind === kind && l.identity.isEqual(ctx.sender));
  if (!mine) return;
  if (linkCount(ctx, kind, accountId) === 1) {
    const hasTeacher = kind === LEARNER && [...ctx.db.teacherStudent.learnerId.filter(accountId)].length > 0;
    if (!hasTeacher) throw new SenderError('this is the only device signed in to this account; sign in on another device first');
  }
  ctx.db.accountLink.id.delete(mine.id);
}

function parseKind(kind: string): AccountKind {
  if (!ACCOUNT_KINDS.includes(kind as AccountKind)) throw new SenderError(`kind must be one of ${ACCOUNT_KINDS.join(', ')}`);
  return kind as AccountKind;
}

// ================================================================ sign-in codes

function codeHash(ctx: Ctx, code: string): string {
  // AGENT_SECRET as pepper: a leaked table alone does not reveal live codes.
  return sha256Hex(`fibonacci-sign-in:${settings.agentSecret(ctx)}:${normalizeCode(code)}`);
}

function randomCode(ctx: Ctx): string {
  let c = '';
  for (let i = 0; i < A.CODE_LENGTH; i++) c += A.CODE_ALPHABET[ctx.random.integerInRange(0, A.CODE_ALPHABET.length - 1)];
  return c;
}

function pruneCodes(ctx: Ctx, kind: AccountKind, accountId: bigint): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const c of [...ctx.db.signInCode.iter()]) if (c.expiresAt.microsSinceUnixEpoch <= now) ctx.db.signInCode.id.delete(c.id);
  const live = [...ctx.db.signInCode.accountId.filter(accountId)].filter(c => c.kind === kind).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of live.slice(0, Math.max(0, live.length - (A.MAX_LIVE_CODES_PER_ACCOUNT - 1)))) ctx.db.signInCode.id.delete(c.id);
}

/**
 * A one-time code that links another device to the account. Who may ask:
 * - a device linked to the account ("Sign in on another device"; DEVICE_CODE_TTL_S),
 * - for a student: a teacher of that student, as `teacherId` (STUDENT_CODE_TTL_S),
 * - the agent (operator scripts; OPERATOR_CODE_TTL_S).
 */
export function issueSignInCode(ctx: Ctx, args: { kind: string; accountId: bigint; teacherId: bigint }): IssueCodeResult {
  const kind = parseKind(args.kind);
  const row = kind === LEARNER ? ctx.db.learner.id.find(args.accountId) : ctx.db.teacher.id.find(args.accountId);
  if (!row) return { ok: false, error: `${kind} ${args.accountId} not found` };
  if (kind === LEARNER && (row as LearnerRow).isSimulated) return { ok: false, error: E.simulated };
  let ttl: number;
  if (isAgent(ctx)) ttl = A.OPERATOR_CODE_TTL_S;
  else if (isLinked(ctx, kind, args.accountId)) ttl = A.DEVICE_CODE_TTL_S;
  else if (kind === LEARNER && args.teacherId !== 0n && isLinked(ctx, TEACHER, args.teacherId) && isTeacherOf(ctx, args.teacherId, args.accountId)) ttl = A.STUDENT_CODE_TTL_S;
  else return { ok: false, error: kind === LEARNER ? E.notYourStudent : E.teacherOtherDevice };

  pruneCodes(ctx, kind, args.accountId);
  let code = randomCode(ctx);
  for (let i = 0; i < 8 && ctx.db.signInCode.codeHash.find(codeHash(ctx, code)); i++) code = randomCode(ctx);
  const expires = ctx.timestamp.microsSinceUnixEpoch + secs(ttl);
  ctx.db.signInCode.insert({
    id: 0n,
    codeHash: codeHash(ctx, code),
    kind,
    accountId: args.accountId,
    issuedBy: ctx.sender,
    createdAt: ctx.timestamp,
    expiresAt: ts(expires),
  });
  return { ok: true, code, kind, accountId: String(args.accountId), name: row.name, expiresMs: Number(expires / 1000n) };
}

export type LinkDeviceResult = { ok: true; kind: AccountKind; accountId: string; name: string } | { ok: false; error: string };

/** Redeems a code: links the sender to its account and deletes the code. A wrong code counts
 *  against the sender's attempt window (committed even though the call fails). */
export function linkDevice(ctx: PCtx, raw: string): LinkDeviceResult {
  type Out = LinkDeviceResult | 'bad';
  const r = ctx.withTx((tx): Out => {
    const now = tx.timestamp.microsSinceUnixEpoch;
    const att = tx.db.codeAttempt.identity.find(tx.sender);
    if (att && now - att.windowStartMicros < secs(A.ATTEMPT_WINDOW_S) && att.failures >= A.MAX_FAILED_ATTEMPTS) return { ok: false, error: E.tooManyAttempts };
    const code = normalizeCode(raw);
    if (code.length !== A.CODE_LENGTH || [...code].some(ch => !A.CODE_ALPHABET.includes(ch))) return 'bad';
    const row = tx.db.signInCode.codeHash.find(codeHash(tx, code));
    if (!row || row.expiresAt.microsSinceUnixEpoch <= now) return 'bad';
    const kind = row.kind as AccountKind;
    const account = kind === LEARNER ? tx.db.learner.id.find(row.accountId) : tx.db.teacher.id.find(row.accountId);
    tx.db.signInCode.id.delete(row.id);
    if (!account) return 'bad';
    link(tx, kind, row.accountId, 'code');
    if (att) tx.db.codeAttempt.identity.delete(tx.sender);
    return { ok: true, kind, accountId: String(row.accountId), name: account.name };
  });
  if (r !== 'bad') return r;
  ctx.withTx(tx => {
    const now = tx.timestamp.microsSinceUnixEpoch;
    const att = tx.db.codeAttempt.identity.find(tx.sender);
    if (!att) tx.db.codeAttempt.insert({ identity: tx.sender, windowStartMicros: now, failures: 1 });
    else if (now - att.windowStartMicros >= secs(A.ATTEMPT_WINDOW_S)) tx.db.codeAttempt.identity.update({ ...att, windowStartMicros: now, failures: 1 });
    else tx.db.codeAttempt.identity.update({ ...att, failures: att.failures + 1 });
  });
  return { ok: false, error: E.badCode };
}

// ================================================================ views (index.ts registers them)

type ViewDb = ViewCtx<Schema>['db'];

export function myLearners(db: ViewDb, sender: Identity): LearnerRow[] {
  const out: LearnerRow[] = [];
  for (const l of db.accountLink.identity.filter(sender)) {
    if (l.kind !== LEARNER) continue;
    const row = db.learner.id.find(l.accountId);
    if (row && !out.some(o => o.id === row.id)) out.push(row);
  }
  return out;
}

export function myTeachers(db: ViewDb, sender: Identity): TeacherRow[] {
  const out: TeacherRow[] = [];
  for (const l of db.accountLink.identity.filter(sender)) {
    if (l.kind !== TEACHER) continue;
    const row = db.teacher.id.find(l.accountId);
    if (row && !out.some(o => o.id === row.id)) out.push(row);
  }
  return out;
}

/** Real students on the rosters of the sender's teachers (no simulated students). */
export function myStudents(db: ViewDb, sender: Identity): LearnerRow[] {
  const out: LearnerRow[] = [];
  for (const t of myTeachers(db, sender)) {
    for (const r of db.teacherStudent.teacherId.filter(t.id)) {
      const row = db.learner.id.find(r.learnerId);
      if (row && !row.isSimulated && !out.some(o => o.id === row.id)) out.push(row);
    }
  }
  return out;
}

/** The roster rows of the sender's teachers (which teacher a student belongs to). */
export function myRoster(db: ViewDb, sender: Identity) {
  return myTeachers(db, sender).flatMap(t => [...db.teacherStudent.teacherId.filter(t.id)]);
}

/** Legacy accounts anyone may claim once (created before authorization, never linked). */
export function claimableLearners(db: ViewDb): LearnerRow[] {
  const at = db.authMeta.id.find(0)?.enabledAt.microsSinceUnixEpoch ?? 0n;
  return [...db.learner.iter()].filter(l => !l.isSimulated && isClaimable(LEARNER, l, at, db.accountLink.accountId.filter(l.id)));
}

export function claimableTeachers(db: ViewDb): TeacherRow[] {
  const at = db.authMeta.id.find(0)?.enabledAt.microsSinceUnixEpoch ?? 0n;
  return [...db.teacher.iter()].filter(t => isClaimable(TEACHER, t, at, db.accountLink.accountId.filter(t.id)));
}
