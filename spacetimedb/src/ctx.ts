// Shared helpers for reducers and procedure transactions.
import { SenderError, type InferSchema, type ReducerCtx, type ProcedureCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import type spacetimedb from './schema';

export type S = InferSchema<typeof spacetimedb>;
/** Reducer context or a procedure's transaction context. */
export type Ctx = ReducerCtx<S>;
export type PCtx = ProcedureCtx<S>;

export type SessionRow = NonNullable<ReturnType<Ctx['db']['session']['id']['find']>>;
export type TurnRow = NonNullable<ReturnType<Ctx['db']['turn']['id']['find']>>;
export type PhraseRow = NonNullable<ReturnType<Ctx['db']['phrase']['id']['find']>>;
export type SentenceRow = NonNullable<ReturnType<Ctx['db']['replySentence']['id']['find']>>;
export type MetricsRow = NonNullable<ReturnType<Ctx['db']['turnMetrics']['id']['find']>>;
export type BoardItemRow = NonNullable<ReturnType<Ctx['db']['boardItem']['id']['find']>>;
export type NoteRow = NonNullable<ReturnType<Ctx['db']['memoryNote']['id']['find']>>;

export const AGENT_ROLE = 'agent';

export function isAgent(ctx: Ctx): boolean {
  return ctx.db.role.identity.find(ctx.sender)?.role === AGENT_ROLE;
}

export function requireAgent(ctx: Ctx): void {
  if (!isAgent(ctx)) throw new SenderError('agent only');
}

export function getSession(ctx: Ctx, sessionId: bigint): SessionRow {
  const s = ctx.db.session.id.find(sessionId);
  if (!s) throw new SenderError(`session ${sessionId} not found`);
  return s;
}

export function getActiveSession(ctx: Ctx, sessionId: bigint): SessionRow {
  const s = getSession(ctx, sessionId);
  if (!s.active) throw new SenderError(`session ${sessionId} has ended`);
  return s;
}

export function nowMicros(ctx: Ctx): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

export function dueIn(ctx: Ctx, seconds = 0): ReturnType<typeof ScheduleAt.time> {
  return ScheduleAt.time(nowMicros(ctx) + BigInt(Math.round(seconds * 1_000_000)));
}

export function ts(micros: bigint): Timestamp {
  return new Timestamp(micros);
}

export function sessionTurns(ctx: Ctx, sessionId: bigint): TurnRow[] {
  return [...ctx.db.turn.sessionId.filter(sessionId)].sort((a, b) => a.idx - b.idx);
}

export function findTurn(ctx: Ctx, sessionId: bigint, idx: number): TurnRow | undefined {
  for (const t of ctx.db.turn.bySessionIdx.filter([sessionId, idx])) return t;
  return undefined;
}

export function findPhrase(ctx: Ctx, sessionId: bigint, phraseId: number): PhraseRow | undefined {
  for (const p of ctx.db.phrase.bySessionPhrase.filter([sessionId, phraseId])) return p;
  return undefined;
}

export function findSentence(ctx: Ctx, utteranceId: bigint, idx: number): SentenceRow | undefined {
  for (const s of ctx.db.replySentence.byUtteranceIdx.filter([utteranceId, idx])) return s;
  return undefined;
}

/** Sentences of one utterance in idx order. Uses the single-column utteranceId index: a prefix
 *  scan on byUtteranceIdx ([utteranceId] alone) is valid on the host, but the 2.13 test datastore
 *  cannot decode a prefix whose last element is a point (empty range end). */
export function utteranceSentences(ctx: Ctx, sessionId: bigint, utteranceId: bigint): SentenceRow[] {
  return [...ctx.db.replySentence.utteranceId.filter(utteranceId)].filter(s => s.sessionId === sessionId).sort((a, b) => a.idx - b.idx);
}

/** turn_metrics row for (sessionId, student turnIdx), created on first use. */
export function metricsFor(ctx: Ctx, sessionId: bigint, turnIdx: number): MetricsRow {
  for (const m of ctx.db.turnMetrics.bySessionTurn.filter([sessionId, turnIdx])) return m;
  return ctx.db.turnMetrics.insert({
    id: 0n,
    sessionId,
    turnIdx,
    utteranceId: 0n,
    turnEndAt: undefined,
    sttDoneAt: undefined,
    llmFirstTokenAt: undefined,
    firstSentenceAt: undefined,
    firstAudioAt: undefined,
    firstPlaybackAt: undefined,
    noiseDb: 0,
    preemptive: false,
  });
}

export function metricsForUtterance(ctx: Ctx, sessionId: bigint, utteranceId: bigint): MetricsRow | undefined {
  if (utteranceId === 0n) return undefined;
  for (const m of ctx.db.turnMetrics.utteranceId.filter(utteranceId)) if (m.sessionId === sessionId) return m;
  return undefined;
}

/** Called after every updateSession with the stored row before and after (classroom: a
 *  simulated session going back to `listening` schedules the next student message). */
export type SessionHook = (ctx: Ctx, prev: SessionRow, next: SessionRow) => void;
const sessionHooks: SessionHook[] = [];
export function onSessionUpdated(hook: SessionHook): void {
  if (!sessionHooks.includes(hook)) sessionHooks.push(hook);
}

export function updateSession(ctx: Ctx, s: SessionRow, patch: Partial<SessionRow>): SessionRow {
  const prev = sessionHooks.length ? (ctx.db.session.id.find(s.id) ?? s) : s;
  const next = ctx.db.session.id.update({ ...s, ...patch });
  for (const h of sessionHooks) h(ctx, prev, next);
  return next;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

export function parseJson<T = unknown>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
