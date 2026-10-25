// Voice output: utterances, sentences, TTS jobs, playback state, interrupts, tutor turns.
import { SenderError } from 'spacetimedb/server';
import { OPENING_TURN_IDX, SOURCE_TEXT, SOURCE_VOICE, type SentenceStatus, type TtsResult, type TurnState, type TurnStatus } from '../../shared/src/types';
import {
  type Ctx,
  type PCtx,
  type SentenceRow,
  type SessionRow,
  cancelTtsJobs,
  dueIn,
  findSentence,
  findTurn,
  getActiveSession,
  metricsFor,
  metricsForUtterance,
  sessionTurns,
  truncate,
  updateSession,
  utteranceSentences,
} from './ctx';
import { onTurnAppended } from './memory';
import { queueTextSentence } from './text_mode';
import { hasLessonBeats, onUtteranceEnd } from './pipeline';
import { ProviderError, synthesize, ttsRequest } from './providers';

const PENDING: SentenceStatus = 'pending';
const READY: SentenceStatus = 'ready';
const PLAYED: SentenceStatus = 'played';
const DROPPED: SentenceStatus = 'dropped';
const LISTENING: TurnState = 'listening';
const THINKING: TurnState = 'thinking';
const SPEAKING: TurnState = 'speaking';
const INTERRUPTED: TurnState = 'interrupted';
const T_OPEN: TurnStatus = 'open';
const T_CLOSING: TurnStatus = 'closing';
const T_READY: TurnStatus = 'ready';
const T_DONE: TurnStatus = 'done';

const SENTENCE_MAX = 600;
const TTS_RETRIES = 1;

export function beginUtterance(
  ctx: Ctx,
  args: { sessionId: bigint; utteranceId: bigint; replyToIdx: number; preemptive: boolean }
): void {
  const session = getActiveSession(ctx, args.sessionId);
  if (args.utteranceId === 0n) throw new SenderError('utteranceId must be non-zero');
  if (findSentence(ctx, args.utteranceId, 0) || metricsForUtterance(ctx, args.sessionId, args.utteranceId)) {
    throw new SenderError(`utterance ${args.utteranceId} already exists`);
  }
  const target = findTurn(ctx, args.sessionId, args.replyToIdx);
  if (!target || target.role !== 'student') throw new SenderError(`no student turn ${args.replyToIdx}`);
  const m = metricsFor(ctx, args.sessionId, args.replyToIdx);
  // Another reply to this turn is already speaking (e.g. a second worker): keep the first one.
  if (m.utteranceId !== 0n && m.utteranceId !== args.utteranceId && session.currentUtteranceId === m.utteranceId) {
    throw new SenderError(`turn ${args.replyToIdx} is already being answered by utterance ${m.utteranceId}`);
  }
  // A reply still marked current is superseded: its lesson (if any) ends as interrupted.
  // Its unsynthesized/unplayed sentences are dropped (no more TTS for them) and clients flush it,
  // so a late block of the old reply can never play over (or flush) the new one.
  if (session.currentUtteranceId !== 0n && session.currentUtteranceId !== args.utteranceId) {
    const old = session.currentUtteranceId;
    onUtteranceEnd(ctx, session.id, old, 'interrupted');
    for (const s of utteranceSentences(ctx, session.id, old)) {
      if (s.status === PENDING || s.status === READY) ctx.db.replySentence.id.update({ ...s, status: DROPPED });
    }
    cancelTtsJobs(ctx, session.id, old);
    ctx.db.playbackFlush.insert({ sessionId: session.id, utteranceId: old });
  }
  updateSession(ctx, ctx.db.session.id.find(session.id)!, { currentUtteranceId: args.utteranceId });
  ctx.db.turnMetrics.id.update({ ...m, utteranceId: args.utteranceId, preemptive: args.preemptive });
}

export function addSentence(
  ctx: Ctx,
  args: { sessionId: bigint; utteranceId: bigint; idx: number; display: string; speech: string }
): SentenceRow {
  const session = getActiveSession(ctx, args.sessionId);
  if (args.utteranceId === 0n || session.currentUtteranceId !== args.utteranceId) {
    throw new SenderError(`utterance ${args.utteranceId} is not current (stale or interrupted)`);
  }
  const speech = args.speech.trim();
  if (!speech) throw new SenderError('empty sentence');
  if (speech.length > SENTENCE_MAX || args.display.length > SENTENCE_MAX) throw new SenderError('sentence too long');
  if (findSentence(ctx, args.utteranceId, args.idx)) throw new SenderError(`sentence ${args.idx} already exists`);
  const row = ctx.db.replySentence.insert({
    id: 0n,
    sessionId: args.sessionId,
    utteranceId: args.utteranceId,
    idx: args.idx,
    display: truncate(args.display, SENTENCE_MAX),
    speech,
    status: session.voice ? PENDING : READY,
    createdAt: ctx.timestamp,
  });
  if (args.idx === 0) {
    const m = metricsForUtterance(ctx, args.sessionId, args.utteranceId);
    if (m && !m.firstSentenceAt) ctx.db.turnMetrics.id.update({ ...m, firstSentenceAt: ctx.timestamp });
  }
  // Text mode: no TTS. The sentence is shown at once and counts as played after its reading time.
  if (!session.voice) {
    queueTextSentence(ctx, session, row);
    return row;
  }
  ctx.db.ttsJob.insert({
    scheduledId: 0n,
    scheduledAt: dueIn(ctx),
    sessionId: args.sessionId,
    sentenceId: row.id,
    utteranceId: args.utteranceId,
    idx: args.idx,
    speech,
  });
  return row;
}

/** Scheduled: one sentence -> audio_out. Skips sentences dropped by an interrupt.
 *  No read-only transaction before the HTTP call (~7 ms on the critical path, see
 *  docs/latency-internal.md): the job row is the input, and the insert transaction below
 *  checks `pending`, so a sentence dropped before or during the call never gets audio. The
 *  cost is one wasted TTS call for a sentence already dropped when its job starts. */
export function synthesizeSentence(
  ctx: PCtx,
  job: { sessionId: bigint; sentenceId: bigint; utteranceId: bigint; idx: number; speech: string },
  attempt = 0
): void {
  let audio;
  try {
    audio = synthesize(ctx, ttsRequest(ctx, job.speech));
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    console.warn(`synthesizeSentence utterance ${job.utteranceId} idx ${job.idx} attempt ${attempt}: ${e.message}`);
    if (attempt < TTS_RETRIES) return synthesizeSentence(ctx, job, attempt + 1);
    // Give up: mark dropped so playback (strictly by index) can skip it.
    ctx.withTx(tx => {
      const s = tx.db.replySentence.id.find(job.sentenceId);
      if (s && s.status === PENDING) tx.db.replySentence.id.update({ ...s, status: DROPPED });
      maybeFinishSpeaking(tx, job.sessionId, job.utteranceId);
    });
    return;
  }

  ctx.withTx(tx => {
    const s = tx.db.replySentence.id.find(job.sentenceId);
    if (!s || s.status !== PENDING) return; // dropped while synthesizing
    tx.db.audioOut.insert(audioRow(job, audio));
    tx.db.replySentence.id.update({ ...s, status: READY });
    const session = tx.db.session.id.find(job.sessionId);
    if (session && session.currentUtteranceId === job.utteranceId && session.turnState !== INTERRUPTED && session.turnState !== SPEAKING) {
      updateSession(tx, session, { turnState: SPEAKING });
    }
    if (job.idx === 0) {
      const m = metricsForUtterance(tx, job.sessionId, job.utteranceId);
      if (m && !m.firstAudioAt) tx.db.turnMetrics.id.update({ ...m, firstAudioAt: tx.timestamp });
    }
  });
}

/** audio_out row of one synthesized sentence (word timings empty when TTS gave none). */
export function audioRow(job: { sessionId: bigint; utteranceId: bigint; idx: number }, audio: TtsResult) {
  return {
    sessionId: job.sessionId,
    utteranceId: job.utteranceId,
    idx: job.idx,
    pcm: audio.pcm,
    sampleRate: audio.sampleRate,
    words: audio.words?.words ?? [],
    wordStartsMs: audio.words?.startsMs ?? [],
    wordEndsMs: audio.words?.endsMs ?? [],
  };
}

export function markPlayed(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint; idx: number }): void {
  const s = findSentence(ctx, args.utteranceId, args.idx);
  if (!s || s.sessionId !== args.sessionId) return;
  if (s.status === READY) ctx.db.replySentence.id.update({ ...s, status: PLAYED });
  if (args.idx === 0) {
    const m = metricsForUtterance(ctx, args.sessionId, args.utteranceId);
    if (m && !m.firstPlaybackAt) ctx.db.turnMetrics.id.update({ ...m, firstPlaybackAt: ctx.timestamp });
  }
  maybeFinishSpeaking(ctx, args.sessionId, args.utteranceId);
}

export function tutorTurnFor(ctx: Ctx, sessionId: bigint, utteranceId: bigint) {
  for (const t of ctx.db.turn.sessionId.filter(sessionId)) if (t.role === 'tutor' && t.utteranceId === utteranceId) return t;
  return undefined;
}

/** Tutor turn appended and every sentence played (or dropped) -> listening. */
export function maybeFinishSpeaking(ctx: Ctx, sessionId: bigint, utteranceId: bigint): void {
  const session = ctx.db.session.id.find(sessionId);
  if (!session || session.currentUtteranceId !== utteranceId) return;
  if (!tutorTurnFor(ctx, sessionId, utteranceId)) return;
  if (utteranceSentences(ctx, sessionId, utteranceId).some(s => s.status === PENDING || s.status === READY)) return;
  finishUtterance(ctx, session);
}

function finishUtterance(ctx: Ctx, session: SessionRow): void {
  onUtteranceEnd(ctx, session.id, session.currentUtteranceId, 'finished');
  session = ctx.db.session.id.find(session.id)!;
  const turnState = session.turnState === SPEAKING || session.turnState === THINKING || session.turnState === INTERRUPTED ? LISTENING : session.turnState;
  updateSession(ctx, session, { currentUtteranceId: 0n, turnState });
}

/** What the student actually heard (or read) of an utterance: its played sentences. */
export function heardText(ctx: Ctx, sessionId: bigint, utteranceId: bigint): string {
  return utteranceSentences(ctx, sessionId, utteranceId)
    .filter(s => s.status === PLAYED)
    .map(s => s.display)
    .join(' ');
}

export function interrupt(ctx: Ctx, sessionId: bigint): void {
  const session = getActiveSession(ctx, sessionId);
  const utteranceId = session.currentUtteranceId;
  if (utteranceId === 0n && session.turnState === LISTENING) return; // nothing to interrupt
  // Before unplayed sentences are dropped: the lesson keeps what the learner already saw.
  onUtteranceEnd(ctx, sessionId, utteranceId, 'interrupted');
  let tutorSideClosed = false;
  if (utteranceId !== 0n) {
    const sentences = utteranceSentences(ctx, sessionId, utteranceId);
    for (const s of sentences) {
      if (s.status === PENDING || s.status === READY) ctx.db.replySentence.id.update({ ...s, status: DROPPED });
    }
    cancelTtsJobs(ctx, sessionId, utteranceId);
    // The worker usually appends the tutor turn as soon as the LLM finishes, before playback
    // ends. Then the turn must be corrected to what the student actually heard.
    const tutorTurn = tutorTurnFor(ctx, sessionId, utteranceId);
    if (tutorTurn) ctx.db.turn.id.update({ ...tutorTurn, interrupted: true, text: heardText(ctx, sessionId, utteranceId) });
    tutorSideClosed = !!tutorTurn;
  }
  ctx.db.playbackFlush.insert({ sessionId, utteranceId });
  // Tutor turn already appended: no appendTutorTurn will follow to leave `interrupted`, so the
  // session listens at once (the task canvas only unlocks while `listening`).
  updateSession(ctx, session, { turnState: tutorSideClosed ? LISTENING : INTERRUPTED, currentUtteranceId: 0n });
}

/**
 * Barge-in on the utterance this client was PLAYING. The session already counts an utterance as
 * over once its last sentence starts (markPlayed -> currentUtteranceId 0, listening), so a plain
 * interrupt during the last sentence found nothing to interrupt and the tutor turn stayed
 * interrupted=false. Utterance-scoped: the current utterance -> interrupt(); an utterance that just
 * finished -> its tutor turn is marked interrupted (the learner cut into its last sentence) and
 * the client's playback is flushed. Older or unknown utterances are ignored.
 */
export function interruptUtterance(ctx: Ctx, sessionId: bigint, utteranceId: bigint): void {
  const session = getActiveSession(ctx, sessionId);
  if (utteranceId === 0n || utteranceId === session.currentUtteranceId) return interrupt(ctx, sessionId);
  if (session.currentUtteranceId !== 0n) return interrupt(ctx, sessionId); // a newer reply is speaking: barge-in on it
  const tutorTurn = tutorTurnFor(ctx, sessionId, utteranceId);
  if (!tutorTurn || tutorTurn.interrupted) return;
  // Only the latest tutor turn: a barge-in cannot cut into an utterance that something else followed.
  const later = sessionTurns(ctx, sessionId).some(t => t.role === 'tutor' && t.idx > tutorTurn.idx);
  if (later) return;
  ctx.db.turn.id.update({ ...tutorTurn, interrupted: true });
  ctx.db.playbackFlush.insert({ sessionId, utteranceId });
}

/**
 * Appends the tutor turn (what was actually spoken). A student turn that started while this
 * utterance was playing (barge-in) and isn't ready yet is moved behind the tutor turn, so turn
 * order matches what was said.
 */
export function appendTutorTurn(
  ctx: Ctx,
  args: { sessionId: bigint; utteranceId: bigint; text: string; interrupted: boolean }
): void {
  let session = getActiveSession(ctx, args.sessionId);
  if (args.utteranceId === 0n) throw new SenderError('utteranceId must be non-zero');
  const existing = tutorTurnFor(ctx, args.sessionId, args.utteranceId);
  // Closed by the module already (a typed turn interrupted this reply): nothing left to record,
  // but a session still in the barge-in state for it must not stay `interrupted`.
  if (existing?.interrupted) {
    if (session.currentUtteranceId === 0n && session.turnState === INTERRUPTED) updateSession(ctx, session, { turnState: LISTENING });
    return;
  }
  if (existing) throw new SenderError(`tutor turn for utterance ${args.utteranceId} exists`);
  const m = metricsForUtterance(ctx, args.sessionId, args.utteranceId);
  // The opening reply (OPENING_TURN_IDX) answers no student turn: it goes before all of them.
  const replyToIdx = m && m.turnIdx !== OPENING_TURN_IDX ? m.turnIdx : -1;
  // An interrupted lesson records what was actually played (the worker cannot map beats to sentences).
  const text = (args.interrupted && hasLessonBeats(ctx, args.sessionId, args.utteranceId) ? heardText(ctx, args.sessionId, args.utteranceId) : args.text).trim();

  if (m) {
    const answered = findTurn(ctx, args.sessionId, m.turnIdx);
    if (answered && answered.status === T_READY) ctx.db.turn.id.update({ ...answered, status: T_DONE });
  }

  if (text) {
    // Student turns opened during this utterance and not yet ready move one slot back.
    const later = sessionTurns(ctx, args.sessionId).filter(t => t.idx > replyToIdx);
    let idx = session.turnCount;
    const firstLive = later.findIndex(t => t.role === 'student' && (t.status === T_OPEN || t.status === T_CLOSING));
    if (firstLive >= 0 && later.slice(firstLive).every(t => t.role === 'student' && (t.status === T_OPEN || t.status === T_CLOSING))) {
      const moving = later.slice(firstLive).sort((a, b) => b.idx - a.idx);
      idx = moving[moving.length - 1]!.idx;
      for (const t of moving) shiftStudentTurn(ctx, t.sessionId, t.idx, t.idx + 1);
    }
    ctx.db.turn.insert({
      id: 0n,
      sessionId: args.sessionId,
      idx,
      role: 'tutor',
      text,
      status: T_DONE,
      pendingPhrases: 0,
      utteranceId: args.utteranceId,
      interrupted: args.interrupted,
      createdAt: ctx.timestamp,
      closedAt: ctx.timestamp,
      source: session.voice ? SOURCE_VOICE : SOURCE_TEXT,
      intent: '',
      hasPhoto: false,
    });
    session = updateSession(ctx, session, { turnCount: session.turnCount + 1 });
    onTurnAppended(ctx, args.sessionId);
    session = ctx.db.session.id.find(args.sessionId)!;
  }

  if (session.currentUtteranceId !== args.utteranceId) {
    // Interrupted (or superseded) earlier: leave the barge-in state once the tutor side is closed.
    if (session.turnState === INTERRUPTED) updateSession(ctx, session, { turnState: LISTENING });
    return;
  }
  const unplayed = utteranceSentences(ctx, args.sessionId, args.utteranceId).some(s => s.status === PENDING || s.status === READY);
  if (!text || !unplayed) finishUtterance(ctx, session);
}

/** Moves a not-yet-ready student turn to a new idx (phrases and metrics follow). */
function shiftStudentTurn(ctx: Ctx, sessionId: bigint, from: number, to: number): void {
  const t = findTurn(ctx, sessionId, from);
  if (!t) return;
  ctx.db.turn.id.update({ ...t, idx: to });
  for (const p of [...ctx.db.phrase.sessionId.filter(sessionId)]) if (p.turnIdx === from) ctx.db.phrase.id.update({ ...p, turnIdx: to });
  for (const m of [...ctx.db.turnMetrics.bySessionTurn.filter([sessionId, from])]) ctx.db.turnMetrics.id.update({ ...m, turnIdx: to });
}

export function setTurnState(ctx: Ctx, sessionId: bigint, state: string, allowed: readonly string[]): void {
  if (!allowed.includes(state)) throw new SenderError(`unknown turn state ${state}`);
  const session = getActiveSession(ctx, sessionId);
  updateSession(ctx, session, { turnState: state });
}
