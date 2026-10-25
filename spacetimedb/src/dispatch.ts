// Cloudflare dispatch (docs/CLOUD_PLAN.md Part B, module env LLM_DISPATCH=cloudflare): the module
// starts every LLM step itself instead of waiting for a subscribed Node worker.
//
//   student turn ready / startConversation
//     -> llm_dispatch row (module-allocated utteranceId) + dispatch_job (due now) + dispatch_watch_job
//   dispatchTurn (scheduled procedure)
//     tx 1: re-check the dispatch is current; build the body (planner request, photos, topic, prelude)
//     HTTP: POST CF_DISPATCH_URL, HMAC-signed, expects 202 within 5 s
//     tx 2: sent | one retry (new utteranceId) | the authored fallback line
//   the Cloudflare Worker streams Claude and calls beginUtterance/beginLesson/addBeat/appendTutorTurn
//     over HTTP as an agent identity; noteProgress (index.ts) tracks running/done per utterance
//   dispatchWatch (scheduled reducer): no reply sentence after WATCH_FIRST_S -> retry once, then the
//     fallback line; a reply that stops (no sentence for STALL_S, no tutor turn) is closed.
//
// With LLM_DISPATCH=worker (default) nothing here runs and no row is written.
import { SenderError } from 'spacetimedb/server';
import { TimeDuration } from 'spacetimedb';
import { LEARNER_QUESTIONS } from '../../shared/src/lesson/api';
import { pack } from '../../shared/src/lesson/index';
import { openingLines } from '../../shared/src/opening';
import { OPENING_TURN_IDX } from '../../shared/src/types';
import { type Ctx, type PCtx, type SessionRow, dueIn, metricsForUtterance, nowMicros, sessionTurns, updateSession, utteranceSentences } from './ctx';
import { settings } from './env';
import { signDispatch } from './hmac';
import { beginOpening } from './opening';
import { buildLessonRequest, onUtteranceEnd, prefetchTopic } from './pipeline';
import { base64 } from './providers';
import { turnImageFor } from './turn_photo';
import { addSentence, appendTutorTurn, beginUtterance, heardText, tutorTurnFor } from './voice_out';

export type DispatchRow = NonNullable<ReturnType<Ctx['db']['llmDispatch']['id']['find']>>;
export const DISPATCH_STATUSES = ['pending', 'sent', 'running', 'done', 'failed', 'superseded'] as const;
const OPEN = new Set(['pending', 'sent', 'running']);

/** No reply sentence this long after the dispatch -> retry once (the Node worker's stallRetryMs). */
export const WATCH_FIRST_S = 12;
/** A reply that spoke: no new sentence and no tutor turn for this long -> closed by the module. */
export const STALL_S = 20;
const REARM_S = 6;
const POST_TIMEOUT_MS = 5000;
const RETRY_DELAY_S = 0.5;
/** Spoken when the Cloudflare Worker cannot answer (same line as LessonRun's fallback). */
export const FALLBACK_LINE = LEARNER_QUESTIONS.clarify_step;
const ERROR_MAX = 300;

export const isCloudflare = (ctx: { env: unknown }) => settings.llmDispatch(ctx) !== 'worker';

const short = (s: string) => (s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 1)}…` : s);

/** Unique, increasing utterance id (micros; a collision moves it up by one). */
function allocUtteranceId(ctx: Ctx): bigint {
  let id = nowMicros(ctx) > 0n ? nowMicros(ctx) : 1n;
  while (dispatchFor(ctx, id)) id++;
  return id;
}

export function dispatchFor(ctx: Ctx, utteranceId: bigint): DispatchRow | undefined {
  if (utteranceId === 0n) return undefined;
  for (const d of ctx.db.llmDispatch.utteranceId.filter(utteranceId)) return d;
  return undefined;
}

function create(ctx: Ctx, a: { sessionId: bigint; kind: 'turn' | 'opening'; turnIdx: number; attempt: number; withImage?: boolean }): DispatchRow {
  // A newer step makes every open dispatch of the session stale (its run is rejected as not current).
  for (const d of [...ctx.db.llmDispatch.sessionId.filter(a.sessionId)]) {
    if (d.status === 'pending' || d.status === 'sent') ctx.db.llmDispatch.id.update({ ...d, status: 'superseded' });
  }
  const session = ctx.db.session.id.find(a.sessionId);
  const imageSent = [...ctx.db.llmDispatch.sessionId.filter(a.sessionId)].some(d => d.withImage);
  const row = ctx.db.llmDispatch.insert({
    id: 0n,
    sessionId: a.sessionId,
    kind: a.kind,
    turnIdx: a.turnIdx,
    utteranceId: allocUtteranceId(ctx),
    status: 'pending',
    attempt: a.attempt,
    withImage: a.withImage ?? (!imageSent && !!session?.hasImage),
    createdAt: ctx.timestamp,
    sentAt: undefined,
    acceptedAt: undefined,
    firstBeatAt: undefined,
    lastBeatAt: undefined,
    error: '',
  });
  if (settings.llmDispatch(ctx) === 'cloudflare') ctx.db.dispatchJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx, a.attempt ? RETRY_DELAY_S : 0), dispatchId: row.id });
  ctx.db.dispatchWatchJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx, WATCH_FIRST_S + (a.attempt ? RETRY_DELAY_S : 0)), dispatchId: row.id });
  return row;
}

/** completeTurn: a student turn is ready (voice, text, sim, interaction). */
export function onTurnReady(ctx: Ctx, sessionId: bigint, turnIdx: number): void {
  if (!isCloudflare(ctx)) return;
  create(ctx, { sessionId, kind: 'turn', turnIdx, attempt: 0 });
}

/** startConversation: the tutor speaks first. Lesson opening (authored lead-in + first lesson) via
 *  Cloudflare when there is a task; otherwise the authored opening script, spoken by the module. */
export function onOpening(ctx: Ctx, sessionId: bigint): void {
  if (!isCloudflare(ctx)) return;
  const session = ctx.db.session.id.find(sessionId);
  if (!session?.active || session.turnState !== 'thinking' || session.currentUtteranceId !== 0n) return;
  if ([...ctx.db.llmDispatch.sessionId.filter(sessionId)].some(d => d.kind === 'opening')) return;
  writeStatus(ctx);
  if (lessonOpening(session)) {
    create(ctx, { sessionId, kind: 'opening', turnIdx: OPENING_TURN_IDX, attempt: 0 });
    return;
  }
  const lines = openingLines(pack.prompts.openingScript, session.taskText);
  const d = ctx.db.llmDispatch.insert({
    id: 0n, sessionId, kind: 'opening', turnIdx: OPENING_TURN_IDX, utteranceId: allocUtteranceId(ctx), status: 'done', attempt: 0, withImage: false,
    createdAt: ctx.timestamp, sentAt: undefined, acceptedAt: undefined, firstBeatAt: ctx.timestamp, lastBeatAt: ctx.timestamp, error: 'authored opening (module)',
  });
  speak(ctx, d, lines.length ? lines : [FALLBACK_LINE]);
}

const lessonOpening = (s: SessionRow) => !!pack.prompts.openingLessonScript && (!!s.taskText.trim() || s.hasImage);

/** agent_status row 0 for the UI: with Cloudflare dispatch there is no heartbeat; the module writes it. */
function writeStatus(ctx: Ctx): void {
  const busy = [...ctx.db.llmDispatch.iter()].filter(d => d.status === 'sent' || d.status === 'running').length;
  const row = { id: 0, model: 'claude-haiku-5-5', provider: 'cloudflare', busySessions: busy, lastSeen: ctx.timestamp };
  if (ctx.db.agentStatus.id.find(0)) ctx.db.agentStatus.id.update(row);
  else ctx.db.agentStatus.insert(row);
}

// ------------------------------------------------------------------ progress (agent reducers)

/** Called by the agent reducers (index.ts) after they succeeded. */
export function noteProgress(ctx: Ctx, utteranceId: bigint, what: 'began' | 'sentence' | 'tutorTurn'): void {
  if (!isCloudflare(ctx)) return;
  const d = dispatchFor(ctx, utteranceId);
  if (!d) return;
  if (what === 'began') {
    if (d.status === 'pending' || d.status === 'sent') ctx.db.llmDispatch.id.update({ ...d, status: 'running' });
  } else if (what === 'sentence') {
    ctx.db.llmDispatch.id.update({ ...d, status: OPEN.has(d.status) ? 'running' : d.status, firstBeatAt: d.firstBeatAt ?? ctx.timestamp, lastBeatAt: ctx.timestamp });
  } else if (OPEN.has(d.status)) ctx.db.llmDispatch.id.update({ ...d, status: 'done' });
}

/** LLM_DISPATCH=cloudflare: only a dispatched, not yet started utterance may begin (one answerer:
 *  a Node worker still running, a duplicate delivery, a superseded run). */
export function assertDispatched(ctx: Ctx, utteranceId: bigint): void {
  if (!isCloudflare(ctx)) return;
  const d = dispatchFor(ctx, utteranceId);
  if (!d) throw new SenderError(`utterance ${utteranceId} was not dispatched (LLM_DISPATCH=cloudflare)`);
  if (d.status !== 'pending' && d.status !== 'sent') throw new SenderError(`utterance ${utteranceId} is not current (dispatch ${d.status})`);
}

// ------------------------------------------------------------------ dispatchTurn (scheduled procedure)

/** Body the Cloudflare Worker receives (cf-worker/src/types.ts DispatchBody). u64 as decimal strings. */
export interface DispatchBody {
  v: 1;
  dispatchId: string;
  attempt: number;
  kind: 'turn' | 'opening';
  sessionId: string;
  turnIdx: number;
  utteranceId: string;
  transcript: string;
  /** Raw buildLessonRequest result (JSON {ok, request, topic, library, say?, sayOnly?}). */
  built: string;
  /** Session photo (data URL), once per session. */
  image: string;
  /** Photo sent with this turn (data URL) or ''. */
  turnImage: string;
  /** First dispatch of a session without a concept: prefetchTopic result, for the LLM classifier. */
  topic: { ok: boolean; category: string; concept: string; source: string; text: string; hasImage: boolean } | null;
  /** Lesson opening: authored lead-in lines spoken before the lesson. */
  prelude: string[];
  /** Module clock when the body was built (unix ms). */
  builtAtMs: number;
}

/** Still the step to answer? '' = yes, else why not. */
function staleReason(ctx: Ctx, d: DispatchRow): string {
  const s = ctx.db.session.id.find(d.sessionId);
  if (!s?.active) return 'session ended';
  if (!OPEN.has(d.status)) return `dispatch ${d.status}`;
  if (d.kind === 'opening') {
    if (sessionTurns(ctx, d.sessionId).some(t => t.role === 'tutor' || (t.status !== 'open' && t.status !== 'closing'))) return 'the conversation already started';
    return '';
  }
  const latest = sessionTurns(ctx, d.sessionId).at(-1);
  const student = sessionTurns(ctx, d.sessionId).filter(t => t.role === 'student').at(-1);
  if (!student || student.idx !== d.turnIdx) return 'a newer student turn';
  if (latest && latest.role === 'tutor' && latest.idx > d.turnIdx) return 'already answered';
  return '';
}

function sessionImage(ctx: Ctx, sessionId: bigint): string {
  const own = ctx.db.sessionImage.sessionId.find(sessionId);
  let img: { mime: string; data: Uint8Array } | null = own ? { mime: own.mime, data: own.data } : null;
  if (!img) {
    const s = ctx.db.session.id.find(sessionId);
    const cls = s?.classSessionId ? ctx.db.classSession.id.find(s.classSessionId) : undefined;
    const doc = cls ? ctx.db.classDocument.classSessionId.find(cls.id) : undefined;
    if (cls && doc) img = { mime: cls.documentMime, data: doc.data };
  }
  return img ? `data:${img.mime};base64,${base64(img.data)}` : '';
}

function buildBody(ctx: Ctx, d: DispatchRow): DispatchBody {
  const session = ctx.db.session.id.find(d.sessionId)!;
  const first = ![...ctx.db.llmDispatch.sessionId.filter(d.sessionId)].some(o => o.id !== d.id && o.sentAt !== undefined);
  const topic = first && !session.concept ? (JSON.parse(prefetchTopic(ctx, d.sessionId)) as DispatchBody['topic']) : null;
  const turn = d.kind === 'turn' ? sessionTurns(ctx, d.sessionId).find(t => t.idx === d.turnIdx) : undefined;
  const photo = turn?.hasPhoto ? turnImageFor(ctx, d.sessionId, d.turnIdx) : null;
  const leadIn = pack.prompts.openingLessonScript;
  return {
    v: 1,
    dispatchId: String(d.id),
    attempt: d.attempt,
    kind: d.kind as DispatchBody['kind'],
    sessionId: String(d.sessionId),
    turnIdx: d.turnIdx,
    utteranceId: String(d.utteranceId),
    transcript: turn?.text ?? '',
    built: buildLessonRequest(ctx, d.sessionId, String(d.utteranceId)),
    image: d.withImage ? sessionImage(ctx, d.sessionId) : '',
    turnImage: photo ? `data:${photo.mime};base64,${base64(photo.data)}` : '',
    topic,
    prelude: d.kind === 'opening' && leadIn ? openingLines(leadIn, session.taskText) : [],
    builtAtMs: Number(nowMicros(ctx) / 1000n),
  };
}

/** Scheduled (dispatch_job): POSTs one dispatch to the Cloudflare Worker. */
export function dispatchTurn(ctx: PCtx, job: { dispatchId: bigint }): void {
  const prep = ctx.withTx(tx => {
    const d = tx.db.llmDispatch.id.find(job.dispatchId);
    if (!d || d.status !== 'pending') return null;
    const why = staleReason(tx, d);
    if (why) {
      tx.db.llmDispatch.id.update({ ...d, status: 'superseded', error: why });
      return null;
    }
    const url = settings.cfDispatchUrl(tx);
    const secret = settings.cfDispatchSecret(tx);
    if (!url || !secret) {
      tx.db.llmDispatch.id.update({ ...d, status: 'failed', error: 'CF_DISPATCH_URL / CF_DISPATCH_SECRET not set' });
      speakFallback(tx, d);
      return null;
    }
    const body = JSON.stringify(buildBody(tx, d));
    tx.db.llmDispatch.id.update({ ...d, sentAt: tx.timestamp });
    const ts = String(Number(nowMicros(tx) / 1000n));
    const nonce = `${d.id}:${d.attempt}`;
    return { url, body, ts, nonce, sig: signDispatch(secret, ts, nonce, body) };
  });
  if (!prep) return;
  let status = 0;
  let error = '';
  try {
    const res = ctx.http.fetch(prep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dispatch-Ts': prep.ts, 'X-Dispatch-Nonce': prep.nonce, 'X-Dispatch-Signature': prep.sig },
      body: prep.body,
      timeout: TimeDuration.fromMillis(POST_TIMEOUT_MS),
    });
    status = res.status;
    if (status !== 202) error = `HTTP ${status}: ${short(res.text())}`;
  } catch (e) {
    error = `fetch failed: ${short(String(e))}`;
  }
  ctx.withTx(tx => {
    const d = tx.db.llmDispatch.id.find(job.dispatchId);
    if (!d) return;
    if (status === 202) {
      // The worker may already have called beginUtterance (running) before this transaction.
      tx.db.llmDispatch.id.update({ ...d, status: d.status === 'pending' ? 'sent' : d.status, acceptedAt: tx.timestamp });
      writeStatus(tx);
      return;
    }
    console.warn(`dispatchTurn ${d.id} (session ${d.sessionId}, attempt ${d.attempt}): ${error}`);
    if (d.status !== 'pending') return; // superseded meanwhile
    retryOrFallback(tx, d, error);
  });
}

/** LLM_DISPATCH=manual (local testing, procedures cannot reach a local Worker): the agent takes the
 *  session's pending dispatch body itself (marked sent) and replays it to `wrangler dev`. '' = none. */
export function takeDispatch(ctx: Ctx, sessionId: bigint): string {
  if (settings.llmDispatch(ctx) !== 'manual') throw new SenderError('takeDispatch needs LLM_DISPATCH=manual');
  const d = [...ctx.db.llmDispatch.sessionId.filter(sessionId)].filter(x => x.status === 'pending').sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (!d) return '';
  const why = staleReason(ctx, d);
  if (why) {
    ctx.db.llmDispatch.id.update({ ...d, status: 'superseded', error: why });
    return '';
  }
  const body = JSON.stringify(buildBody(ctx, d));
  ctx.db.llmDispatch.id.update({ ...ctx.db.llmDispatch.id.find(d.id)!, status: 'sent', sentAt: ctx.timestamp, acceptedAt: ctx.timestamp });
  return body;
}

// ------------------------------------------------------------------ retry, fallback, watch

/** A silent utterance of a failed attempt is released so the retry (new utteranceId) may begin. */
function releaseSilent(ctx: Ctx, d: DispatchRow): void {
  const s = ctx.db.session.id.find(d.sessionId);
  if (s && s.currentUtteranceId === d.utteranceId) {
    onUtteranceEnd(ctx, s.id, d.utteranceId, 'interrupted');
    updateSession(ctx, ctx.db.session.id.find(s.id)!, { currentUtteranceId: 0n });
  }
  const m = metricsForUtterance(ctx, d.sessionId, d.utteranceId);
  if (m) ctx.db.turnMetrics.id.update({ ...m, utteranceId: 0n });
}

export function retryOrFallback(ctx: Ctx, d: DispatchRow, why: string): void {
  ctx.db.llmDispatch.id.update({ ...d, status: 'failed', error: short(why) });
  if (staleReason(ctx, { ...d, status: 'pending' })) return;
  if (utteranceSentences(ctx, d.sessionId, d.utteranceId).length) return; // spoke already: the watch closes it
  releaseSilent(ctx, d);
  if (d.attempt === 0) {
    console.warn(`dispatch ${d.id} (session ${d.sessionId}): ${short(why)}; retrying once`);
    create(ctx, { sessionId: d.sessionId, kind: d.kind as 'turn' | 'opening', turnIdx: d.turnIdx, attempt: 1, withImage: d.withImage });
    return;
  }
  console.warn(`dispatch ${d.id} (session ${d.sessionId}): ${short(why)}; speaking the fallback line`);
  speakFallback(ctx, d);
}

function speakFallback(ctx: Ctx, d: DispatchRow): void {
  speak(ctx, d, [FALLBACK_LINE]);
}

/** Speaks authored lines as utterance d.utteranceId and closes it (no LLM). Never throws. */
function speak(ctx: Ctx, d: DispatchRow, lines: string[]): void {
  try {
    const s = ctx.db.session.id.find(d.sessionId);
    if (!s?.active) return;
    if (s.currentUtteranceId !== d.utteranceId) {
      if (s.currentUtteranceId !== 0n) return; // another reply is speaking
      if (d.kind === 'opening') beginOpening(ctx, { sessionId: d.sessionId, utteranceId: d.utteranceId });
      else beginUtterance(ctx, { sessionId: d.sessionId, utteranceId: d.utteranceId, replyToIdx: d.turnIdx, preemptive: false });
    }
    let idx = utteranceSentences(ctx, d.sessionId, d.utteranceId).length;
    for (const line of lines) addSentence(ctx, { sessionId: d.sessionId, utteranceId: d.utteranceId, idx: idx++, display: line, speech: line });
    appendTutorTurn(ctx, { sessionId: d.sessionId, utteranceId: d.utteranceId, text: lines.join(' '), interrupted: false });
  } catch (e) {
    console.warn(`dispatch ${d.id}: authored line failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Scheduled (dispatch_watch_job): liveness of one dispatch. */
export function dispatchWatch(ctx: Ctx, job: { dispatchId: bigint }): void {
  const d = ctx.db.llmDispatch.id.find(job.dispatchId);
  if (!d || !OPEN.has(d.status)) return;
  const s = ctx.db.session.id.find(d.sessionId);
  if (!s?.active) {
    ctx.db.llmDispatch.id.update({ ...d, status: 'failed', error: 'session ended' });
    return;
  }
  const spoke = utteranceSentences(ctx, d.sessionId, d.utteranceId).length > 0;
  if (!spoke) {
    const why = staleReason(ctx, d);
    if (why) return void ctx.db.llmDispatch.id.update({ ...d, status: 'superseded', error: why });
    return retryOrFallback(ctx, d, `no reply within ${WATCH_FIRST_S} s (${d.status})`);
  }
  if (tutorTurnFor(ctx, d.sessionId, d.utteranceId)) return void ctx.db.llmDispatch.id.update({ ...d, status: 'done' });
  const last = d.lastBeatAt?.microsSinceUnixEpoch ?? d.createdAt.microsSinceUnixEpoch;
  const current = s.currentUtteranceId === d.utteranceId;
  if (current && nowMicros(ctx) - last < BigInt(STALL_S) * 1_000_000n) {
    ctx.db.dispatchWatchJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx, REARM_S), dispatchId: d.id });
    return;
  }
  // The run stopped (or was cut off by a barge-in) without its tutor turn: close it from what was said.
  try {
    appendTutorTurn(ctx, { sessionId: d.sessionId, utteranceId: d.utteranceId, text: current ? utteranceSentences(ctx, d.sessionId, d.utteranceId).map(x => x.display).join(' ') : heardText(ctx, d.sessionId, d.utteranceId), interrupted: !current });
  } catch (e) {
    console.warn(`dispatchWatch ${d.id}: closing failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.db.llmDispatch.id.update({ ...ctx.db.llmDispatch.id.find(d.id)!, status: current ? 'failed' : 'done', error: current ? `stalled: no sentence for ${STALL_S} s` : 'closed after barge-in' });
}
