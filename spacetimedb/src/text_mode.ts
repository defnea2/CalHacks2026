// Text mode (contract section 1): typed student turns and sessions without STT/TTS.
//
// - submitTextTurn appends a complete student turn (status ready) in one step. Same TurnManager
//   semantics as voice: one open student turn (a live, fully transcribed spoken turn absorbs the
//   typed text), and a running tutor reply is interrupted like a barge-in (playback_flush, unplayed
//   sentences dropped, the tutor turn records what was heard and goes BEFORE the new turn).
// - session.voice = false: addSentence inserts no tts_job. The sentence is `ready` at once and a
//   scheduled text_play_job marks it `played` after its reading time (TEXT_SENTENCE_MS_PER_WORD),
//   sentences one after another, so turnState still flows thinking -> speaking -> listening.
import { SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { INTENT_TEXT, SOURCE_TEXT, TURN_INTENTS, type SentenceStatus, type TurnIntent, type TurnState } from '../../shared/src/types';
import { type Ctx, type SentenceRow, type SessionRow, getActiveSession, metricsFor, metricsForUtterance, nowMicros, updateSession } from './ctx';
import { completeTurn, liveStudentTurn, openStudentTurn } from './voice_in';
import { appendTutorTurn, heardText, interrupt, maybeFinishSpeaking, tutorTurnFor } from './voice_out';

const READY: SentenceStatus = 'ready';
const PLAYED: SentenceStatus = 'played';
const SPEAKING: TurnState = 'speaking';
const INTERRUPTED: TurnState = 'interrupted';

/** Reading time of one sentence in text mode (ms). */
export function readingMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(MODULE_DEFAULTS.TEXT_SENTENCE_MIN_MS, words * MODULE_DEFAULTS.TEXT_SENTENCE_MS_PER_WORD);
}

/** Text mode: a just-inserted `ready` sentence is read after the previous one of its utterance. */
export function queueTextSentence(ctx: Ctx, session: SessionRow, row: SentenceRow): void {
  const now = nowMicros(ctx);
  const clock = ctx.db.textPlayback.sessionId.find(session.id);
  const start = clock && clock.utteranceId === row.utteranceId && clock.endsAtMicros > now ? clock.endsAtMicros : now;
  const end = start + BigInt(readingMs(row.display)) * 1000n;
  const next = { sessionId: session.id, utteranceId: row.utteranceId, endsAtMicros: end };
  if (clock) ctx.db.textPlayback.sessionId.update(next);
  else ctx.db.textPlayback.insert(next);
  ctx.db.textPlayJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(end),
    sessionId: session.id,
    sentenceId: row.id,
    utteranceId: row.utteranceId,
    idx: row.idx,
  });
  if (session.currentUtteranceId === row.utteranceId && session.turnState !== INTERRUPTED && session.turnState !== SPEAKING) {
    updateSession(ctx, session, { turnState: SPEAKING });
  }
  if (row.idx === 0) {
    // Shown at once: "audio" ready and playback started at the same moment.
    const m = metricsForUtterance(ctx, session.id, row.utteranceId);
    if (m && !m.firstAudioAt) ctx.db.turnMetrics.id.update({ ...m, firstAudioAt: ctx.timestamp, firstPlaybackAt: ctx.timestamp });
  }
}

/** Scheduled: the reading time of a text-mode sentence passed. Skips sentences dropped meanwhile. */
export function finishTextSentence(ctx: Ctx, job: { sessionId: bigint; sentenceId: bigint; utteranceId: bigint }): void {
  const s = ctx.db.replySentence.id.find(job.sentenceId);
  if (!s || s.status !== READY) return;
  ctx.db.replySentence.id.update({ ...s, status: PLAYED });
  maybeFinishSpeaking(ctx, job.sessionId, job.utteranceId);
}

export function setSessionVoice(ctx: Ctx, sessionId: bigint, voice: boolean): void {
  const session = getActiveSession(ctx, sessionId);
  if (session.voice !== voice) updateSession(ctx, session, { voice });
}

export function submitTextTurn(ctx: Ctx, args: { sessionId: bigint; text: string; intent: string }, source: string = SOURCE_TEXT, opts: { assessed?: boolean } = {}): void {
  if (!TURN_INTENTS.includes(args.intent as TurnIntent)) throw new SenderError(`unknown intent ${args.intent}; use one of ${TURN_INTENTS.filter(Boolean).join(', ')} or ''`);
  let text = args.text.replace(/\s+/g, ' ').trim();
  if (text.length > MODULE_DEFAULTS.TEXT_TURN_MAX_CHARS) throw new SenderError(`text too long (max ${MODULE_DEFAULTS.TEXT_TURN_MAX_CHARS} characters)`);
  if (!text) {
    if (!args.intent) throw new SenderError('empty turn');
    text = INTENT_TEXT[args.intent as Exclude<TurnIntent, ''>];
  }
  let session = getActiveSession(ctx, args.sessionId);

  // A spoken turn still waiting for transcription would interleave with the typed one.
  let turn = liveStudentTurn(ctx, session.id);
  if (turn) {
    const streaming = [...ctx.db.phrase.sessionId.filter(session.id)].some(p => p.turnIdx === turn!.idx && (p.status === 'streaming' || p.status === 'transcribing'));
    if (streaming || turn.pendingPhrases > 0) throw new SenderError('a spoken turn is still being transcribed; send again in a moment');
  }

  // Interrupts a running tutor reply like a barge-in, and records what was heard before the new turn.
  const utteranceId = session.currentUtteranceId;
  if (utteranceId !== 0n) {
    interrupt(ctx, session.id);
    if (!tutorTurnFor(ctx, session.id, utteranceId)) {
      appendTutorTurn(ctx, { sessionId: session.id, utteranceId, text: heardText(ctx, session.id, utteranceId), interrupted: true });
    }
    session = ctx.db.session.id.find(session.id)!;
    turn = liveStudentTurn(ctx, session.id); // may have moved behind the tutor turn
  }

  if (turn) turn = ctx.db.turn.id.update({ ...turn, text: `${turn.text} ${text}`.trim(), source, intent: args.intent });
  else turn = openTyped(ctx, session, text, source, args.intent);
  const m = metricsFor(ctx, session.id, turn.idx);
  ctx.db.turnMetrics.id.update({ ...m, turnEndAt: ctx.timestamp });
  completeTurn(ctx, ctx.db.turn.id.find(turn.id)!, opts);
}

function openTyped(ctx: Ctx, session: SessionRow, text: string, source: string, intent: string) {
  const t = openStudentTurn(ctx, session, source, intent);
  return ctx.db.turn.id.update({ ...t, text });
}
