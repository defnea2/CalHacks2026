// Module entry. Reducer/procedure SIGNATURES are the contract (Stream 0, lead-owned):
// client and worker bindings are generated from them. Bodies delegate to the files next to
// this one; only registered reducers/procedures are named exports here.
import './polyfills';
import { t, SenderError } from 'spacetimedb/server';
import spacetimedb, { learner as learnerTable, sttJob, ttsJob, extractionJob, summaryJob, retentionJob } from './schema';
import { dashboardJob, simTurnJob, teacher as teacherTable } from './schema_classroom';
import { teacherStudent } from './schema_auth';
import * as classroom from './classroom';
import * as auth from './auth';
import { textPlayJob } from './schema_pipeline';
import { METRIC_NAMES, TURN_STATES, type MetricName } from '../../shared/src/types';
import { AGENT_ROLE, getActiveSession, getSession, metricsFor, requireAgent, ts } from './ctx';
import { settings } from './env';
import { ensureLibrary } from './library';
import * as insights from './insights';
import * as lesson from './lesson';
import * as memory from './memory';
import * as opening from './opening';
import { base64 } from './providers';
import * as seed from './seed';
import * as sessions from './sessions';
import * as textMode from './text_mode';
import * as turnPhoto from './turn_photo';
import * as pipeline from './pipeline';
import { ensureRetentionJob, sweepRetention } from './retention';
import * as voiceIn from './voice_in';
import * as voiceOut from './voice_out';

export default spacetimedb;

// ---------------------------------------------------------------- lifecycle

export const init = spacetimedb.init(ctx => {
  ensureLibrary(ctx);
  classroom.ensureSimProfiles(ctx);
  auth.ensureAuthMeta(ctx);
  ensureRetentionJob(ctx);
  classroom.backfillClusterMembers(ctx);
});

/** init only runs when the database is created; a republished pack reloads on the next connect. */
export const onConnect = spacetimedb.clientConnected(ctx => {
  ensureLibrary(ctx);
  classroom.ensureSimProfiles(ctx);
  auth.ensureAuthMeta(ctx);
  ensureRetentionJob(ctx);
  classroom.backfillClusterMembers(ctx);
});
/** Marks the connection's (real) learners offline in `presence`. */
export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  classroom.onDisconnect(ctx);
});

// ---------------------------------------------------------------- client reducers
// Authorization (auth.ts): every client reducer checks the caller first. Student reducers:
// the learner/session must belong to a learner linked to the caller; the agent passes.

/** A student adds themselves: the calling device owns the new learner. */
export const createTestUser = spacetimedb.reducer(
  { name: t.string(), age: t.u32(), grade: t.u32(), style: t.string() },
  (ctx, args) => {
    auth.onAccountCreated(ctx, auth.LEARNER, sessions.createTestUser(ctx, args).id);
  }
);

/** Ends the learner's previous active session, then starts a new one. Own learner only. */
export const startSession = spacetimedb.reducer(
  { learnerId: t.u64(), taskText: t.string() },
  (ctx, args) => {
    auth.requireLearner(ctx, args.learnerId);
    turnPhoto.recordOwner(ctx, sessions.startSession(ctx, args).id);
  }
);

export const uploadPhoto = spacetimedb.reducer(
  { sessionId: t.u64(), mime: t.string(), data: t.byteArray() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    sessions.uploadPhoto(ctx, args);
  }
);

/** Photo taken during the session (jpeg/png/webp/gif, <= 1 MB); goes with the learner's next
 *  closed turn. Replaces a still-pending one. Only the session's learner (turn_photo.ts). */
export const attachImage = spacetimedb.reducer(
  { sessionId: t.u64(), mime: t.string(), data: t.byteArray() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    turnPhoto.attachImage(ctx, args);
  }
);

export const removePendingImage = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  turnPhoto.removePendingImage(ctx, sessionId);
});

export const endSession = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  sessions.endSession(ctx, sessionId);
});

/** One ~150 ms chunk of 16 kHz PCM16, buffered in audio_in. `final` closes the phrase:
 *  raises pendingPhrases on the open student turn and inserts an stt_job due now.
 *  Repeated (sessionId, phraseId, seq) ignored. Emits speech_activity. */
export const pushAudio = spacetimedb.reducer(
  { sessionId: t.u64(), phraseId: t.u32(), seq: t.u32(), pcm: t.byteArray(), final: t.bool() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    voiceIn.pushAudio(ctx, args);
  }
);

/** VAD_TURN_MS of silence after the last phrase. Turn becomes ready when pendingPhrases hits 0. */
export const endTurn = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  voiceIn.endTurn(ctx, sessionId);
});

/** "Start talking" clicked: on a session without turns, asks the worker to speak first
 *  (turnState = thinking, opening turn_metrics row). No-op once the conversation started. */
export const startConversation = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  opening.startConversation(ctx, sessionId);
});

/** Barge-in: turnState = interrupted, unplayed sentences dropped, playback_flush emitted. */
export const interrupt = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  voiceOut.interrupt(ctx, sessionId);
});
/** Barge-in on the utterance the client was playing (also its last sentence, after the session moved on). */
export const interruptUtterance = spacetimedb.reducer({ sessionId: t.u64(), utteranceId: t.u64() }, (ctx, { sessionId, utteranceId }) => {
  auth.requireSessionLearner(ctx, sessionId);
  voiceOut.interruptUtterance(ctx, sessionId, utteranceId);
});

/** Client started playing a sentence (drives firstPlaybackAt and "unplayed" for interrupts). */
export const markPlayed = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    voiceOut.markPlayed(ctx, args);
  }
);

export const submitGapAnswer = spacetimedb.reducer(
  { boardItemId: t.u64(), answer: t.string() },
  (ctx, args) => {
    const item = ctx.db.boardItem.id.find(args.boardItemId);
    if (item) auth.requireSessionLearner(ctx, item.sessionId);
    lesson.submitGapAnswer(ctx, args);
  }
);

/** Client noise floor (dBFS) for the current turn's metrics. */
export const reportNoise = spacetimedb.reducer(
  { sessionId: t.u64(), noiseDb: t.f64() },
  (ctx, { sessionId, noiseDb }) => {
    auth.requireSessionLearner(ctx, sessionId);
    const session = getActiveSession(ctx, sessionId);
    if (!Number.isFinite(noiseDb)) throw new SenderError('noiseDb must be a number');
    // Sent right after endTurn: it belongs to the latest student turn, which may already be ready.
    const turn = voiceIn.latestStudentTurn(ctx, session.id);
    if (!turn) return;
    const m = metricsFor(ctx, sessionId, turn.idx);
    ctx.db.turnMetrics.id.update({ ...m, noiseDb });
  }
);

/** Text mode (contract section 1): appends a complete typed student turn (status ready); intent ''
 *  or one of another_way | smaller_step | continue | demonstrate (empty text allowed with an intent).
 *  Interrupts a running tutor reply like barge-in. */
export const submitTextTurn = spacetimedb.reducer(
  { sessionId: t.u64(), text: t.string(), intent: t.string() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    textMode.submitTextTurn(ctx, args);
  }
);

/** voice = false: text mode (no STT/TTS; sentences count as played after a reading delay). */
export const setSessionVoice = spacetimedb.reducer({ sessionId: t.u64(), voice: t.bool() }, (ctx, { sessionId, voice }) => {
  auth.requireSessionLearner(ctx, sessionId);
  textMode.setSessionVoice(ctx, sessionId, voice);
});

/** Canvas manipulation (math_action: MathAction, activity_action: LearnerAction), picture submission
 *  (submit) or choice ({optionId}) from the team UI. Validated against canvas_state and the lesson
 *  state; recorded in learner_event (accepted or not). submit/choice record evidence and start the
 *  next teaching step (a student turn the worker answers). */
export const submitInteraction = spacetimedb.reducer(
  { sessionId: t.u64(), kind: t.string(), payload: t.string() },
  (ctx, args) => {
    auth.requireSessionLearner(ctx, args.sessionId);
    pipeline.submitInteraction(ctx, args, (tx, sessionId, text) =>
      textMode.submitTextTurn(tx, { sessionId, text, intent: '' }, undefined, { assessed: true })
    );
  }
);

/** UNUSED: no screen calls it and the worker no longer subscribes to tutor_request (the slant
 *  lesson's tutor feedback, which replaced /api/teaching/shear-feedback, has no UI caller). Kept so
 *  published clients and the module tests keep their contract; kind 'shear_feedback'. */
export const requestTutor = spacetimedb.reducer({ sessionId: t.u64(), kind: t.string(), payload: t.string() }, (ctx, args) => {
  auth.requireSessionLearner(ctx, args.sessionId);
  pipeline.requestTutor(ctx, args);
});

// ---------------------------------------------------------------- agent-only reducers

/** Team lesson planner: the streamed meta (planned first), validated before anything is spoken. */
export const beginLesson = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), meta: t.string() },
  (ctx, args) => {
    requireAgent(ctx);
    pipeline.beginLesson(ctx, args);
  }
);

/** One complete moment: visual = compact command JSON or {visual, interactive?, showEquation?, final?}.
 *  Compiled + validated against canvas_state; beat + reply_sentence(s) (+ tts_job in voice mode). */
export const addBeat = spacetimedb.reducer(
  { sessionId: t.u64(), utteranceId: t.u64(), idx: t.u32(), visual: t.string(), narration: t.string() },
  (ctx, args) => {
    requireAgent(ctx);
    pipeline.addBeat(ctx, args);
  }
);

/** Worker heartbeat -> agent_status (replaces /api/teaching/status). */
export const agentHeartbeat = spacetimedb.reducer({ model: t.string(), provider: t.string(), busySessions: t.u32() }, (ctx, args) =>
  pipeline.agentHeartbeat(ctx, args)
);

export const submitTutorResult = spacetimedb.reducer({ requestId: t.u64(), ok: t.bool(), result: t.string() }, (ctx, args) =>
  pipeline.submitTutorResult(ctx, args)
);

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

/** Starts the tutor's opening utterance (no student turn to answer; metrics at OPENING_TURN_IDX).
 *  Only after startConversation, once, and before anything was said. */
export const beginOpening = spacetimedb.reducer({ sessionId: t.u64(), utteranceId: t.u64() }, (ctx, args) => {
  requireAgent(ctx);
  opening.beginOpening(ctx, args);
});

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

/** Demo seed memory for a real learner (scripts/seed-demo.mjs): JSON {notes: [{kind, category,
 *  concept?, text, outcome?, confidence?, quote?}], mastery?: [{concept, mastery}], summary?:
 *  {summary, nextFocus?}, daysAgo?}. Replaces the learner's earlier seeded notes + seed summary;
 *  live notes are kept. Validated against the pack taxonomy, MEMORY_KINDS and MEMORY_OUTCOMES. */
export const seedMemory = spacetimedb.reducer({ learnerId: t.u64(), memory: t.string() }, (ctx, { learnerId, memory }) => {
  requireAgent(ctx);
  seed.seedMemory(ctx, learnerId, memory);
});

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

/** Agent only. Team planner request (JSON {ok, request: ModelRequest} or {ok:false, error}) for the session's current lesson state. */
export const buildLessonRequest = spacetimedb.procedure({ sessionId: t.u64(), requestId: t.string() }, t.string(), (ctx, { sessionId, requestId }) =>
  ctx.withTx(tx => {
    requireAgent(tx);
    return pipeline.buildLessonRequest(tx, sessionId, requestId);
  }));

/** Agent only. Topic prefetch before the first lesson reply (keyword cues of the pack; JSON
 *  {ok, category, concept, source, text, hasImage}); without a concept the worker classifies with the LLM. */
export const prefetchTopic = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (ctx, { sessionId }) =>
  ctx.withTx(tx => {
    requireAgent(tx);
    return pipeline.prefetchTopic(tx, sessionId);
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

/** Agent only. Task photo as a data URL, or '' if none. Class sessions without their own
 *  photo: the teacher's image document. */
export const getSessionImage = spacetimedb.procedure({ sessionId: t.u64() }, t.string(), (ctx, { sessionId }) => {
  const img = ctx.withTx(tx => {
    requireAgent(tx);
    const own = tx.db.sessionImage.sessionId.find(sessionId);
    if (own) return { mime: own.mime, data: own.data };
    const s = tx.db.session.id.find(sessionId);
    const cls = s?.classSessionId ? tx.db.classSession.id.find(s.classSessionId) : undefined;
    const doc = cls ? tx.db.classDocument.classSessionId.find(cls.id) : undefined;
    return cls && doc ? { mime: cls.documentMime, data: doc.data } : null;
  });
  return img ? `data:${img.mime};base64,${base64(img.data)}` : '';
});

/** Agent only. Photo the learner sent with turn `turnIdx` (or the pending one while that turn is
 *  still open) as a data URL, or ''. */
export const getTurnImage = spacetimedb.procedure({ sessionId: t.u64(), turnIdx: t.u32() }, t.string(), (ctx, { sessionId, turnIdx }) => {
  const img = ctx.withTx(tx => {
    requireAgent(tx);
    return turnPhoto.turnImageFor(tx, sessionId, turnIdx);
  });
  return img ? `data:${img.mime};base64,${base64(img.data)}` : '';
});

// Scheduled reducers/procedures are client-callable in 2.13: each one starts with
// auth.requireScheduler (sender = module identity).

/** Joins the phrase's audio_in chunks by seq, POSTs them to STT_BASE_URL/stt (Cartesia batch
 *  interface, served by stt-proxy -> ink-2), appends text to the turn, lowers pendingPhrases,
 *  deletes the audio. Empty transcript or too-short phrase -> discarded. */
export const transcribePhrase = spacetimedb.procedure(
  { onSchedule: sttJob },
  { job: sttJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    voiceIn.transcribePhrase(ctx, job);
    return {};
  }
);

export const synthesizeSentence = spacetimedb.procedure(
  { onSchedule: ttsJob },
  { job: ttsJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    voiceOut.synthesizeSentence(ctx, job);
    return {};
  }
);

/** Scheduled: a text-mode sentence was read (its reading delay passed) -> played. */
export const finishTextSentence = spacetimedb.reducer({ onSchedule: textPlayJob }, { job: textPlayJob.rowType }, (ctx, { job }) => {
  // Not redundant: scheduled reducers stay client-callable in 2.13 (a CLI call reaches the body).
  auth.requireScheduler(ctx);
  textMode.finishTextSentence(ctx, job);
});

/** Scheduled every RETENTION_SWEEP_S: photo bytes / old lesson JSON of ended sessions (retention.ts). */
export const runRetention = spacetimedb.reducer({ onSchedule: retentionJob }, { job: retentionJob.rowType }, ctx => {
  auth.requireScheduler(ctx);
  const r = sweepRetention(ctx);
  if (r.turnImages + r.sessionImages + r.classDocuments + r.lessonSessions > 0) {
    console.log(`retention: ${r.turnImages} turn photos, ${r.sessionImages} task photos, ${r.classDocuments} class documents, lesson JSON of ${r.lessonSessions} sessions`);
  }
});

export const extractMemory = spacetimedb.procedure(
  { onSchedule: extractionJob },
  { job: extractionJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    memory.extractMemory(ctx, job);
    return {};
  }
);

export const summarizeSession = spacetimedb.procedure(
  { onSchedule: summaryJob },
  { job: summaryJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    memory.summarizeSession(ctx, job);
    return {};
  }
);

// ---------------------------------------------------------------- classroom (docs/CLASSROOM.md)

/** A teacher adds themselves: the calling device owns the new teacher account. */
export const createTeacher = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  auth.onAccountCreated(ctx, auth.TEACHER, classroom.createTeacher(ctx, name).id);
});

/** status: offline | waiting | in_session. Own learner only (presence decides who joins a
 *  class). Remembers the caller's connection (disconnect -> offline). */
export const setPresence = spacetimedb.reducer({ learnerId: t.u64(), status: t.string() }, (ctx, { learnerId, status }) => {
  auth.requireLearner(ctx, learnerId);
  classroom.setPresence(ctx, learnerId, status);
});

const START_CLASS_ARGS = {
  teacherId: t.u64(),
  goals: t.string(),
  content: t.string(),
  delivery: t.string(),
  documentName: t.string(),
  documentMime: t.string(),
  documentText: t.string(),
  documentData: t.byteArray(),
  simulatedCount: t.u32(),
};

/** Ends the teacher's previous class session; moves every online student into a new linked
 *  session; simulatedCount > 0 resets and starts simulation users 1..n (text mode).
 *  Same as startClassSessionWith(..., resetSimulated = true); kept for older clients. */
export const startClassSession = spacetimedb.reducer(START_CLASS_ARGS, (ctx, args) => {
  auth.requireTeacher(ctx, args.teacherId);
  classroom.startClassSession(ctx, { ...args, resetSimulated: true });
});

/** startClassSession with the reset as an option: resetSimulated = false lets simulation users
 *  1..n keep their memory and history from earlier runs (they join with new linked sessions). */
export const startClassSessionWith = spacetimedb.reducer({ ...START_CLASS_ARGS, resetSimulated: t.bool() }, (ctx, args) => {
  auth.requireTeacher(ctx, args.teacherId);
  classroom.startClassSession(ctx, args);
});

/** Simulation users 1..count (0 = all 20) back to their seed state (fresh memory), in seed order.
 *  Refused while one of them is in a running class session. Any teacher account on this device
 *  (the simulation is shared by all teachers). */
export const resetSimulatedStudents = spacetimedb.reducer({ count: t.u32() }, (ctx, { count }) => {
  auth.requireAnyTeacher(ctx);
  classroom.resetSimulatedStudents(ctx, count);
});

/** The class session's teacher only. */
export const endClassSession = spacetimedb.reducer({ classSessionId: t.u64() }, (ctx, { classSessionId }) => {
  auth.requireClassTeacher(ctx, classSessionId);
  classroom.endClassSession(ctx, classSessionId);
});

/** learnerId 0 stops observing; an overdue dashboard refresh then runs at once. The class
 *  session's teacher only. */
export const setImpersonation = spacetimedb.reducer({ classSessionId: t.u64(), learnerId: t.u64() }, (ctx, { classSessionId, learnerId }) => {
  auth.requireClassTeacher(ctx, classSessionId);
  classroom.setImpersonation(ctx, classSessionId, learnerId);
});

/** Typed result of refreshDashboard ('' / false / 0 = not set). */
const RefreshDashboardResult = t.object('RefreshDashboardResult', {
  ok: t.bool(),
  /** Why nothing ran ('impersonating', 'already running', 'class session ended', ...). */
  skipped: t.string(),
  /** Provider error of a failed LLM call. */
  error: t.string(),
  /** The cluster answer had to be repaired (size rule, unknown ids). */
  repaired: t.bool(),
  repairs: t.array(t.string()),
  clusters: t.u32(),
  /** Students in no cluster: exactly one in an odd class (dashboard "Not grouped yet"). */
  ungrouped: t.array(t.string()),
});

/** Refresh button: one Haiku call -> class_summary + student_cluster. Skipped while impersonating.
 *  Error convention (ARCHITECTURE §3): a skip or a provider failure is a result ({ok: false}), not a
 *  SenderError, because the button shows it as a note. */
export const refreshDashboard = spacetimedb.procedure({ classSessionId: t.u64() }, RefreshDashboardResult, (ctx, { classSessionId }) => {
  ctx.withTx(tx => auth.requireClassTeacher(tx, classSessionId));
  const r = classroom.refreshDashboard(ctx, classSessionId, false);
  return { ok: r.ok, skipped: r.skipped ?? '', error: r.error ?? '', repaired: r.repaired ?? false, repairs: r.repairs ?? [], clusters: r.clusters ?? 0, ungrouped: r.ungrouped ?? [] };
});

/** Teacher dashboard student profile (long-term memory, mastery, past sessions). Returns JSON
 *  LearnerInsightsResult (shared/src/insights.ts). Only for a teacher account of the caller
 *  whose roster has the learner (auth.ts), plus the module env INSIGHTS_KEY when it is set;
 *  the only read path of the memory tables. */
export const learnerInsights = spacetimedb.procedure({ learnerId: t.u64(), teacherId: t.u64(), key: t.string() }, t.string(), (ctx, a) =>
  JSON.stringify(insights.learnerInsights(ctx, a))
);

/** Scheduled every DASHBOARD_INTERVAL_S per active class session. */
export const dashboardTick = spacetimedb.procedure(
  { onSchedule: dashboardJob },
  { job: dashboardJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    classroom.refreshDashboard(ctx, job.classSessionId, true);
    return {};
  }
);

/** Scheduled: the next simulated student message (Haiku) -> text turn with source 'sim'. */
export const simStudentTurn = spacetimedb.procedure(
  { onSchedule: simTurnJob },
  { job: simTurnJob.rowType },
  t.unit(),
  (ctx, { job }) => {
    auth.requireScheduler(ctx);
    classroom.simStudentTurn(ctx, job);
    return {};
  }
);

// ---------------------------------------------------------------- accounts & sign-in (auth.ts)

/** Teacher "Add student": a learner on the teacher's roster, owned by no device yet; the
 *  teacher hands out a sign-in code (issueSignInCode) the child redeems on their device. */
export const addStudent = spacetimedb.reducer(
  { teacherId: t.u64(), name: t.string(), age: t.u32(), grade: t.u32(), style: t.string() },
  (ctx, { teacherId, ...args }) => {
    auth.requireTeacher(ctx, teacherId);
    auth.addToRoster(ctx, teacherId, sessions.createTestUser(ctx, args).id);
  }
);

/** Legacy accounts (created before authorization was switched on, never linked): the first
 *  identity that claims one owns it. kind: learner | teacher. */
export const claimAccount = spacetimedb.reducer({ kind: t.string(), accountId: t.u64() }, (ctx, { kind, accountId }) =>
  auth.claimAccount(ctx, kind, accountId)
);

/** "Sign out on this device" (refused for the last device that could get the account back). */
export const forgetAccount = spacetimedb.reducer({ kind: t.string(), accountId: t.u64() }, (ctx, { kind, accountId }) =>
  auth.forgetAccount(ctx, kind, accountId)
);

/** One-time sign-in code for an account. JSON IssueCodeResult (shared/src/auth.ts). Allowed for
 *  a device linked to the account, a teacher of the student (teacherId; 0 = none) or the agent. */
export const issueSignInCode = spacetimedb.procedure(
  { kind: t.string(), accountId: t.u64(), teacherId: t.u64() },
  t.string(),
  (ctx, args) => JSON.stringify(ctx.withTx(tx => auth.issueSignInCode(tx, args)))
);

/** Redeems a sign-in code: links the calling device to its account (student or teacher). JSON
 *  {ok, kind, accountId, name} | {ok:false, error}. Wrong codes are throttled per identity. */
export const linkDevice = spacetimedb.procedure({ code: t.string() }, t.string(), (ctx, { code }) => JSON.stringify(auth.linkDevice(ctx, code)));

// ---------------------------------------------------------------- views (per caller)

/** Students this device is signed in as ("Continue as Ava"). */
export const myLearners = spacetimedb.view({ name: 'my_learners', public: true }, t.array(learnerTable.rowType), ctx => auth.myLearners(ctx.db, ctx.sender));

/** Teacher accounts this device is signed in as. */
export const myTeachers = spacetimedb.view({ name: 'my_teachers', public: true }, t.array(teacherTable.rowType), ctx => auth.myTeachers(ctx.db, ctx.sender));

/** Real students on the rosters of this device's teachers. */
export const myStudents = spacetimedb.view({ name: 'my_students', public: true }, t.array(learnerTable.rowType), ctx => auth.myStudents(ctx.db, ctx.sender));

/** Roster rows (teacherId, learnerId) of this device's teachers. */
export const myRoster = spacetimedb.view({ name: 'my_roster', public: true }, t.array(teacherStudent.rowType), ctx => auth.myRoster(ctx.db, ctx.sender));

/** Legacy accounts anyone may claim once (empty in databases created with authorization). */
export const claimableLearners = spacetimedb.anonymousView({ name: 'claimable_learners', public: true }, t.array(learnerTable.rowType), ctx => auth.claimableLearners(ctx.db));
export const claimableTeachers = spacetimedb.anonymousView({ name: 'claimable_teachers', public: true }, t.array(teacherTable.rowType), ctx => auth.claimableTeachers(ctx.db));
