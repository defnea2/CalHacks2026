// Module entry. Reducer/procedure SIGNATURES are the contract (Stream 0, lead-owned):
// client and worker bindings are generated from them. Bodies are owned by the module stream.
import { t, SenderError } from 'spacetimedb/server';
import spacetimedb, { ttsJob, extractionJob, summaryJob } from './schema';

export default spacetimedb;

const todo = (name: string): never => {
  throw new SenderError(`${name}: not implemented yet`);
};

// ---------------------------------------------------------------- lifecycle

export const init = spacetimedb.init(_ctx => {
  // Load the lesson pack's content library into the public library tables (reload on version change).
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

// ---------------------------------------------------------------- client reducers

export const createTestUser = spacetimedb.reducer(
  { name: t.string(), age: t.u32(), grade: t.u32(), style: t.string() },
  (_ctx, _args) => todo('createTestUser')
);

/** Ends the learner's previous active session, then starts a new one. */
export const startSession = spacetimedb.reducer(
  { learnerId: t.u64(), taskText: t.string() },
  (_ctx, _args) => todo('startSession')
);

export const uploadPhoto = spacetimedb.reducer(
  { sessionId: t.u64(), mime: t.string(), data: t.byteArray() },
  (_ctx, _args) => todo('uploadPhoto')
);

export const endSession = spacetimedb.reducer({ sessionId: t.u64() }, (_ctx, _args) => todo('endSession'));

/** One ~150 ms chunk of 16 kHz PCM16. `final` closes the phrase. Repeated (sessionId, phraseId, seq) ignored. */
export const pushAudio = spacetimedb.reducer(
  { sessionId: t.u64(), phraseId: t.u32(), seq: t.u32(), pcm: t.byteArray(), final: t.bool() },
  (_ctx, _args) => todo('pushAudio')
);

/** VAD_TURN_MS of silence after the last phrase. Turn becomes ready when pendingPhrases hits 0. */
export const endTurn = spacetimedb.reducer({ sessionId: t.u64() }, (_ctx, _args) => todo('endTurn'));

/** Barge-in: turnState = interrupted, unplayed sentences dropped, playback_flush emitted. */
export const interrupt = spacetimedb.reducer({ sessionId: t.u64() }, (_ctx, _args) => todo('interrupt'));

/** Client started playing a sentence (drives firstPlaybackAt and "unplayed" for interrupts). */
export const markPlayed = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32() },
  (_ctx, _args) => todo('markPlayed')
);

export const submitGapAnswer = spacetimedb.reducer(
  { boardItemId: t.u64(), answer: t.string() },
  (_ctx, _args) => todo('submitGapAnswer')
);

/** Client noise floor (dBFS) for the current turn's metrics. */
export const reportNoise = spacetimedb.reducer(
  { sessionId: t.u64(), noiseDb: t.f64() },
  (_ctx, _args) => todo('reportNoise')
);

// ---------------------------------------------------------------- agent-only reducers

/** Worker presents AGENT_SECRET once; its identity is stored in `role` as agent. */
export const registerAgent = spacetimedb.reducer({ secret: t.string() }, (_ctx, _args) => todo('registerAgent'));

/** STT result for one phrase (STT runs in the worker). Empty text discards the phrase. */
export const phraseTranscribed = spacetimedb.reducer(
  { sessionId: t.u64(), phraseId: t.u32(), text: t.string() },
  (_ctx, _args) => todo('phraseTranscribed')
);

export const setTurnState = spacetimedb.reducer(
  { sessionId: t.u64(), state: t.string() },
  (_ctx, _args) => todo('setTurnState')
);

/** Starts a tutor utterance replying to student turn `replyToIdx`; worker-chosen unique utteranceId. */
export const beginUtterance = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), replyToIdx: t.u32(), preemptive: t.bool() },
  (_ctx, _args) => todo('beginUtterance')
);

/** Inserts reply_sentence + a tts_job due now. */
export const addSentence = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32(), display: t.string(), speech: t.string() },
  (_ctx, _args) => todo('addSentence')
);

export const setPhase = spacetimedb.reducer(
  { sessionId: t.u64(), phase: t.string(), reason: t.string() },
  (_ctx, _args) => todo('setPhase')
);

/** content: JSON object for the kind, or '' with a library taskKey. expectedAnswer: JSON ExpectedAnswer or ''. */
export const showBoardItem = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    utteranceId: t.u64(),
    sentenceIdx: t.u32(),
    kind: t.string(),
    content: t.string(),
    taskKey: t.string(),
    expectedAnswer: t.string(),
  },
  (_ctx, _args) => todo('showBoardItem')
);

export const clearBoard = spacetimedb.reducer({ sessionId: t.u64() }, (_ctx, _args) => todo('clearBoard'));

/** Final text of a tutor utterance (what was actually spoken if interrupted). */
export const appendTutorTurn = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), text: t.string(), interrupted: t.bool() },
  (_ctx, _args) => todo('appendTutorTurn')
);

/** name: one of METRIC_NAMES; atMicros: unix micros (0 = now). */
export const recordMetric = spacetimedb.reducer(
  { sessionId: t.u64(), turnIdx: t.u32(), name: t.string(), atMicros: t.u64() },
  (_ctx, _args) => todo('recordMetric')
);

export const remember = spacetimedb.reducer(
  { sessionId: t.u64(), kind: t.string(), category: t.string(), concept: t.string(), text: t.string(), outcome: t.string() },
  (_ctx, _args) => todo('remember')
);

// ---------------------------------------------------------------- procedures

/** Agent only. Prompt context text: learner + memory, phase, board, task, topic material. */
export const buildContext = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (_ctx, _args) => todo('buildContext'));

/** Agent only. set_topic tool: validates + stores topic, returns JSON {ok, error?, material, notes}. */
export const setTopic = spacetimedb.procedure(
  { sessionId: t.u64(), category: t.string(), concept: t.string() },
  t.string(),
  (_ctx, _args) => todo('setTopic')
);

/** Agent only. Task photo as a data URL, or '' if none. */
export const getSessionImage = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (_ctx, _args) => todo('getSessionImage'));

export const synthesizeSentence = spacetimedb.procedure(
  { onSchedule: ttsJob },
  { job: ttsJob.rowType },
  t.unit(),
  (_ctx, _args) => todo('synthesizeSentence')
);

export const extractMemory = spacetimedb.procedure(
  { onSchedule: extractionJob },
  { job: extractionJob.rowType },
  t.unit(),
  (_ctx, _args) => todo('extractMemory')
);

export const summarizeSession = spacetimedb.procedure(
  { onSchedule: summaryJob },
  { job: summaryJob.rowType },
  t.unit(),
  (_ctx, _args) => todo('summarizeSession')
);
