// TurnManager: audio chunks -> phrases -> student turns.
import { SenderError } from 'spacetimedb/server';
import { VOICE_DEFAULTS } from '../../shared/src/config';
import type { PhraseStatus, TurnStatus, TurnState } from '../../shared/src/types';
import {
  type Ctx,
  type PCtx,
  type SessionRow,
  type TurnRow,
  dueIn,
  findPhrase,
  findTurn,
  getActiveSession,
  metricsFor,
  sessionTurns,
  updateSession,
} from './ctx';
import { onTurnAppended } from './memory';
import { onStudentTurnReady } from './pipeline';
import { concatBytes, ProviderError, transcribe } from './providers';

const T_OPEN: TurnStatus = 'open';
const T_CLOSING: TurnStatus = 'closing';
const T_READY: TurnStatus = 'ready';
const T_DONE: TurnStatus = 'done';
const P_STREAMING: PhraseStatus = 'streaming';
const P_TRANSCRIBING: PhraseStatus = 'transcribing';
const P_DONE: PhraseStatus = 'done';
const P_DISCARDED: PhraseStatus = 'discarded';
const S_THINKING: TurnState = 'thinking';

/** 16 kHz PCM16 mono: 32 bytes per millisecond. */
const BYTES_PER_MS = (VOICE_DEFAULTS.INPUT_SAMPLE_RATE * 2) / 1000;
/** Retries per phrase after an STT HTTP error (spec: retry once, then discard). */
const STT_RETRIES = 1;
const STT_RETRY_DELAY_S = 0.3;

/** Latest student turn that still accepts phrases (open, or closing and not yet ready). */
/** Most recent student turn in any status (the one a just-ended turn's reports belong to). */
export function latestStudentTurn(ctx: Ctx, sessionId: bigint): TurnRow | undefined {
  const turns = sessionTurns(ctx, sessionId);
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.role === 'student') return turns[i];
  return undefined;
}

export function liveStudentTurn(ctx: Ctx, sessionId: bigint): TurnRow | undefined {
  const turns = sessionTurns(ctx, sessionId);
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role !== 'student') continue;
    return t.status === T_OPEN || t.status === T_CLOSING ? t : undefined;
  }
  return undefined;
}

export function openStudentTurn(ctx: Ctx, session: SessionRow, source = 'voice', intent = ''): TurnRow {
  const idx = session.turnCount;
  updateSession(ctx, session, { turnCount: idx + 1 });
  return ctx.db.turn.insert({
    id: 0n,
    sessionId: session.id,
    idx,
    role: 'student',
    text: '',
    status: T_OPEN,
    pendingPhrases: 0,
    utteranceId: 0n,
    interrupted: false,
    createdAt: ctx.timestamp,
    closedAt: undefined,
    source,
    intent,
  });
}

export function pushAudio(
  ctx: Ctx,
  args: { sessionId: bigint; phraseId: number; seq: number; pcm: Uint8Array; final: boolean }
): void {
  const { sessionId, phraseId, seq, pcm, final } = args;
  assertPcm(pcm);
  const session = getActiveSession(ctx, sessionId);
  let phrase = findPhrase(ctx, sessionId, phraseId);
  if (phrase && phrase.status !== P_STREAMING && phrase.status !== P_TRANSCRIBING) return; // already transcribed
  if (phrase) {
    for (const c of ctx.db.audioIn.bySessionPhrase.filter([sessionId, phraseId])) if (c.seq === seq) return; // exact repeat
    if (phrase.status === P_TRANSCRIBING && final) return; // a second final for the same phrase
  }

  if (!phrase) {
    let turn = liveStudentTurn(ctx, sessionId);
    if (!turn) turn = openStudentTurn(ctx, session);
    else if (turn.status === T_CLOSING) turn = ctx.db.turn.id.update({ ...turn, status: T_OPEN }); // spoke again before ready
    phrase = ctx.db.phrase.insert({
      id: 0n,
      sessionId,
      phraseId,
      turnIdx: turn.idx,
      lastSeq: -1,
      bytes: 0,
      status: P_STREAMING,
      text: '',
      startedAt: ctx.timestamp,
      finalAt: undefined,
      transcribedAt: undefined,
    });
  }

  ctx.db.audioIn.insert({ id: 0n, sessionId, phraseId, seq, pcm });
  ctx.db.speechActivity.insert({ sessionId, phraseId, seq });
  phrase = ctx.db.phrase.id.update({
    ...phrase,
    lastSeq: Math.max(phrase.lastSeq, seq),
    bytes: phrase.bytes + pcm.length,
  });

  if (final && phrase.status === P_STREAMING) {
    ctx.db.phrase.id.update({ ...phrase, status: P_TRANSCRIBING, finalAt: ctx.timestamp });
    const turn = findTurn(ctx, sessionId, phrase.turnIdx);
    if (turn) ctx.db.turn.id.update({ ...turn, pendingPhrases: turn.pendingPhrases + 1 });
    ctx.db.sttJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx), sessionId, phraseId, attempt: 0 });
  }
}

/** Rebuilds a turn's text from its transcribed phrases, in phrase order. */
function turnText(ctx: Ctx, sessionId: bigint, turnIdx: number): string {
  return [...ctx.db.phrase.sessionId.filter(sessionId)]
    .filter(p => p.turnIdx === turnIdx && p.status === P_DONE && p.text)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(p => p.text)
    .join(' ');
}

/** Student turn complete: ready for the worker, or dropped if it has no text. */
export function completeTurn(ctx: Ctx, turn: TurnRow, opts: { assessed?: boolean } = {}): void {
  const session = ctx.db.session.id.find(turn.sessionId);
  if (!turn.text.trim()) {
    dropTurn(ctx, turn);
    return;
  }
  ctx.db.turn.id.update({ ...turn, status: T_READY, closedAt: ctx.timestamp });
  const m = metricsFor(ctx, turn.sessionId, turn.idx);
  ctx.db.turnMetrics.id.update({ ...m, sttDoneAt: ctx.timestamp });
  if (session) {
    updateSession(ctx, session, { turnState: S_THINKING });
    onStudentTurnReady(ctx, ctx.db.turn.id.find(turn.id)!, opts);
    onTurnAppended(ctx, turn.sessionId);
  }
}

/** A turn without any text is removed (no reply). Frees its idx if it was the last one. */
function dropTurn(ctx: Ctx, turn: TurnRow): void {
  const session = ctx.db.session.id.find(turn.sessionId);
  if (session && turn.idx === session.turnCount - 1) {
    ctx.db.turn.id.delete(turn.id);
    updateSession(ctx, session, { turnCount: turn.idx });
    for (const m of [...ctx.db.turnMetrics.bySessionTurn.filter([turn.sessionId, turn.idx])]) ctx.db.turnMetrics.id.delete(m.id);
    for (const p of [...ctx.db.phrase.sessionId.filter(turn.sessionId)]) {
      if (p.turnIdx === turn.idx) ctx.db.phrase.id.delete(p.id);
    }
  } else {
    ctx.db.turn.id.update({ ...turn, status: T_DONE, closedAt: ctx.timestamp });
  }
}

export function endTurn(ctx: Ctx, sessionId: bigint): void {
  getActiveSession(ctx, sessionId);
  const turn = liveStudentTurn(ctx, sessionId);
  if (!turn || turn.status !== T_OPEN) return;
  const m = metricsFor(ctx, sessionId, turn.idx);
  ctx.db.turnMetrics.id.update({ ...m, turnEndAt: ctx.timestamp });
  // Phrases still streaming (no final chunk yet) are finalized by their own final chunk.
  const streaming = [...ctx.db.phrase.sessionId.filter(sessionId)].some(p => p.turnIdx === turn.idx && p.status === P_STREAMING);
  if (turn.pendingPhrases > 0 || streaming) ctx.db.turn.id.update({ ...turn, status: T_CLOSING });
  else completeTurn(ctx, turn);
}

/** Applies a transcription result (text, or null = discard) in one transaction. */
export function finishPhrase(ctx: Ctx, sessionId: bigint, phraseId: number, text: string | null): void {
  const phrase = findPhrase(ctx, sessionId, phraseId);
  if (!phrase || phrase.status !== P_TRANSCRIBING) return;
  const clean = (text ?? '').trim();
  ctx.db.phrase.id.update({
    ...phrase,
    status: clean ? P_DONE : P_DISCARDED,
    text: clean,
    transcribedAt: ctx.timestamp,
  });
  for (const c of [...ctx.db.audioIn.bySessionPhrase.filter([sessionId, phraseId])]) ctx.db.audioIn.id.delete(c.id);

  let turn = findTurn(ctx, sessionId, phrase.turnIdx);
  if (!turn) return;
  turn = ctx.db.turn.id.update({
    ...turn,
    text: turnText(ctx, sessionId, turn.idx),
    pendingPhrases: Math.max(0, turn.pendingPhrases - 1),
  });
  if (turn.status === T_CLOSING && turn.pendingPhrases === 0) {
    const streaming = [...ctx.db.phrase.sessionId.filter(sessionId)].some(p => p.turnIdx === turn!.idx && p.status === P_STREAMING);
    if (!streaming) completeTurn(ctx, turn);
  }
}

/** Scheduled: joins the phrase's chunks by seq and transcribes them in one request. */
export function transcribePhrase(ctx: PCtx, job: { sessionId: bigint; phraseId: number; attempt: number }): void {
  const audio = ctx.withTx(tx => {
    const phrase = findPhrase(tx, job.sessionId, job.phraseId);
    if (!phrase || phrase.status !== P_TRANSCRIBING) return null;
    const chunks = [...tx.db.audioIn.bySessionPhrase.filter([job.sessionId, job.phraseId])].sort((a, b) => a.seq - b.seq);
    return concatBytes(chunks.map(c => c.pcm));
  });
  if (!audio) return;

  if (audio.length / BYTES_PER_MS < VOICE_DEFAULTS.VAD_MIN_SPEECH_MS) {
    console.info(`transcribePhrase: phrase ${job.phraseId} too short (${audio.length} bytes), discarded`);
    ctx.withTx(tx => finishPhrase(tx, job.sessionId, job.phraseId, null));
    return;
  }

  let text: string;
  try {
    text = transcribe(ctx, audio).text;
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    console.warn(`transcribePhrase session ${job.sessionId} phrase ${job.phraseId} attempt ${job.attempt}: ${e.message}`);
    ctx.withTx(tx => {
      if (job.attempt < STT_RETRIES) {
        tx.db.sttJob.insert({
          scheduledId: 0n,
          scheduledAt: dueIn(tx, STT_RETRY_DELAY_S),
          sessionId: job.sessionId,
          phraseId: job.phraseId,
          attempt: job.attempt + 1,
        });
      } else {
        finishPhrase(tx, job.sessionId, job.phraseId, null);
      }
    });
    return;
  }
  ctx.withTx(tx => finishPhrase(tx, job.sessionId, job.phraseId, text));
}

/** Ends open student turns of a session that is being closed. */
export function closeLiveTurns(ctx: Ctx, sessionId: bigint): void {
  const turn = liveStudentTurn(ctx, sessionId);
  if (!turn) return;
  if (turn.text.trim()) ctx.db.turn.id.update({ ...turn, status: T_DONE, closedAt: ctx.timestamp });
  else dropTurn(ctx, turn);
}

function assertPcm(pcm: Uint8Array): void {
  if (pcm.length % 2 !== 0) throw new SenderError('pcm must be 16-bit samples');
  if (pcm.length > 64_000) throw new SenderError('chunk too large');
}
