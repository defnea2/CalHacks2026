// Module entry. Reducer/procedure SIGNATURES are the contract (Stream 0, lead-owned):
// client and worker bindings are generated from them. Bodies delegate to the files next to
// this one; only registered reducers/procedures are named exports here.
import { t, SenderError } from 'spacetimedb/server';
import spacetimedb, { sttJob, ttsJob, extractionJob, summaryJob } from './schema';
import { METRIC_NAMES, TURN_STATES, type MetricName } from '../../shared/src/types';
import { AGENT_ROLE, getActiveSession, getSession, metricsFor, requireAgent, ts } from './ctx';
import { settings } from './env';
import { ensureLibrary } from './library';
import * as lesson from './lesson';
import * as memory from './memory';
import { base64 } from './providers';
import * as sessions from './sessions';
import * as voiceIn from './voice_in';
import * as voiceOut from './voice_out';

export default spacetimedb;

// ---------------------------------------------------------------- lifecycle

export const init = spacetimedb.init(ctx => {
  ensureLibrary(ctx);
});

/** init only runs when the database is created; a republished pack reloads on the next connect. */
export const onConnect = spacetimedb.clientConnected(ctx => {
  ensureLibrary(ctx);
});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ---------------------------------------------------------------- client reducers

export const createTestUser = spacetimedb.reducer(
  { name: t.string(), age: t.u32(), grade: t.u32(), style: t.string() },
  (ctx, args) => {
    sessions.createTestUser(ctx, args);
  }
);

/** Ends the learner's previous active session, then starts a new one. */
export const startSession = spacetimedb.reducer(
  { learnerId: t.u64(), taskText: t.string() },
  (ctx, args) => {
    sessions.startSession(ctx, args);
  }
);

export const uploadPhoto = spacetimedb.reducer(
  { sessionId: t.u64(), mime: t.string(), data: t.byteArray() },
  (ctx, args) => sessions.uploadPhoto(ctx, args)
);

export const endSession = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => sessions.endSession(ctx, sessionId));

/** One ~150 ms chunk of 16 kHz PCM16, buffered in audio_in. `final` closes the phrase:
 *  raises pendingPhrases on the open student turn and inserts an stt_job due now.
 *  Repeated (sessionId, phraseId, seq) ignored. Emits speech_activity. */
export const pushAudio = spacetimedb.reducer(
  { sessionId: t.u64(), phraseId: t.u32(), seq: t.u32(), pcm: t.byteArray(), final: t.bool() },
  (ctx, args) => voiceIn.pushAudio(ctx, args)
);

/** VAD_TURN_MS of silence after the last phrase. Turn becomes ready when pendingPhrases hits 0. */
export const endTurn = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => voiceIn.endTurn(ctx, sessionId));

/** Barge-in: turnState = interrupted, unplayed sentences dropped, playback_flush emitted. */
export const interrupt = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => voiceOut.interrupt(ctx, sessionId));

/** Client started playing a sentence (drives firstPlaybackAt and "unplayed" for interrupts). */
export const markPlayed = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32() },
  (ctx, args) => voiceOut.markPlayed(ctx, args)
);

export const submitGapAnswer = spacetimedb.reducer(
  { boardItemId: t.u64(), answer: t.string() },
  (ctx, args) => {
    lesson.submitGapAnswer(ctx, args);
  }
);

/** Client noise floor (dBFS) for the current turn's metrics. */
export const reportNoise = spacetimedb.reducer(
  { sessionId: t.u64(), noiseDb: t.f64() },
  (ctx, { sessionId, noiseDb }) => {
    const session = getActiveSession(ctx, sessionId);
    if (!Number.isFinite(noiseDb)) throw new SenderError('noiseDb must be a number');
    // Sent right after endTurn: it belongs to the latest student turn, which may already be ready.
    const turn = voiceIn.latestStudentTurn(ctx, session.id);
    if (!turn) return;
    const m = metricsFor(ctx, sessionId, turn.idx);
    ctx.db.turnMetrics.id.update({ ...m, noiseDb });
  }
);

// ---------------------------------------------------------------- agent-only reducers

/** Worker presents AGENT_SECRET once; its identity is stored in `role` as agent. */
export const registerAgent = spacetimedb.reducer({ secret: t.string() }, (ctx, { secret }) => {
    const expected = settings.agentSecret(ctx);
    if (!expected || secret !== expected) throw new SenderError('invalid agent secret');
    const row = { identity: ctx.sender, role: AGENT_ROLE };
    if (ctx.db.role.identity.find(ctx.sender)) ctx.db.role.identity.update(row);
    else ctx.db.role.insert(row);
  });

export const setTurnState = spacetimedb.reducer(
  { sessionId: t.u64(), state: t.string() },
  (ctx, { sessionId, state }) => {
    requireAgent(ctx);
    voiceOut.setTurnState(ctx, sessionId, state, TURN_STATES);
  }
);

/** Starts a tutor utterance replying to student turn `replyToIdx`; worker-chosen unique utteranceId. */
export const beginUtterance = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), replyToIdx: t.u32(), preemptive: t.bool() },
  (ctx, args) => {
    requireAgent(ctx);
    voiceOut.beginUtterance(ctx, args);
  }
);

/** Inserts reply_sentence + a tts_job due now. */
export const addSentence = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32(), display: t.string(), speech: t.string() },
  (ctx, args) => {
    requireAgent(ctx);
    voiceOut.addSentence(ctx, args);
  }
);

export const setPhase = spacetimedb.reducer(
  { sessionId: t.u64(), phase: t.string(), reason: t.string() },
  (ctx, args) => {
    requireAgent(ctx);
    lesson.setPhase(ctx, args);
  }
);

/** content: JSON object for the kind, or '' with a library taskKey. expectedAnswer: JSON ExpectedAnswer or ''. */
export const showBoardItem = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    utteranceId: t.u64(),
    sentenceIdx: t.u32(),
    /** Inline marker offset in that sentence's speech; -1 = none. */
    markerPos: t.i32(),
    kind: t.string(),
    content: t.string(),
    taskKey: t.string(),
    expectedAnswer: t.string(),
  },
  (ctx, args) => {
    requireAgent(ctx);
    lesson.showBoardItem(ctx, args);
  }
);

export const clearBoard = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
    requireAgent(ctx);
    lesson.clearBoard(ctx, sessionId);
  });

/** Final text of a tutor utterance (what was actually spoken if interrupted). */
export const appendTutorTurn = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), text: t.string(), interrupted: t.bool() },
  (ctx, args) => {
    requireAgent(ctx);
    voiceOut.appendTutorTurn(ctx, args);
  }
);

/** name: one of METRIC_NAMES; atMicros: unix micros (0 = now). */
export const recordMetric = spacetimedb.reducer(
  { sessionId: t.u64(), turnIdx: t.u32(), name: t.string(), atMicros: t.u64() },
  (ctx, { sessionId, turnIdx, name, atMicros }) => {
    requireAgent(ctx);
    if (!METRIC_NAMES.includes(name as MetricName)) throw new SenderError(`unknown metric ${name}; use one of ${METRIC_NAMES.join(', ')}`);
    getSession(ctx, sessionId);
    const m = metricsFor(ctx, sessionId, turnIdx);
    const at = atMicros === 0n ? ctx.timestamp : ts(atMicros);
    ctx.db.turnMetrics.id.update({ ...m, [name as MetricName]: at });
  }
);

export const remember = spacetimedb.reducer(
  { sessionId: t.u64(), kind: t.string(), category: t.string(), concept: t.string(), text: t.string(), outcome: t.string() },
  (ctx, args) => {
    requireAgent(ctx);
    memory.remember(ctx, args);
  }
);

// ---------------------------------------------------------------- procedures

/** Agent only. Prompt context text: learner + memory, phase, board, task, topic material. */
export const buildContext = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (ctx, { sessionId }) =>
  ctx.withTx(tx => {
    requireAgent(tx);
    return lesson.buildContext(tx, sessionId);
  }));

/** Agent only. set_topic tool: validates + stores topic, returns JSON {ok, error?, material, notes}. */
export const setTopic = spacetimedb.procedure(
  { sessionId: t.u64(), category: t.string(), concept: t.string() },
  t.string(),
  (ctx, args) =>
    ctx.withTx(tx => {
      requireAgent(tx);
      return lesson.setTopic(tx, args);
    })
);

/** Agent only. Task photo as a data URL, or '' if none. */
export const getSessionImage = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (ctx, { sessionId }) => {
  const img = ctx.withTx(tx => {
    requireAgent(tx);
    return tx.db.sessionImage.sessionId.find(sessionId) ?? null;
  });
  return img ? `data:${img.mime};base64,${base64(img.data)}` : '';
});

/** Joins the phrase's audio_in chunks by seq, POSTs them to STT_BASE_URL/stt (Cartesia batch
 *  interface, served by stt-proxy -> ink-2), appends text to the turn, lowers pendingPhrases,
 *  deletes the audio. Empty transcript or too-short phrase -> discarded. */
export const transcribePhrase = spacetimedb.procedure(
  { onSchedule: sttJob },
  { job: sttJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    voiceIn.transcribePhrase(ctx, job);
    return {};
  }
);

export const synthesizeSentence = spacetimedb.procedure(
  { onSchedule: ttsJob },
  { job: ttsJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    voiceOut.synthesizeSentence(ctx, job);
    return {};
  }
);

export const extractMemory = spacetimedb.procedure(
  { onSchedule: extractionJob },
  { job: extractionJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    memory.extractMemory(ctx, job);
    return {};
  }
);

export const summarizeSession = spacetimedb.procedure(
  { onSchedule: summaryJob },
  { job: summaryJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    memory.summarizeSession(ctx, job);
    return {};
  }
);
