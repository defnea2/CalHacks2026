// Tables of the turn pipeline (contract section 1, owner night/pipeline): text mode and the team
// lesson planner (beats compiled against canvas_state, learner events, lesson state, agent status).
import { table, t } from 'spacetimedb/server';

// ---------------------------------------------------------------- text mode (session.voice = false)

/** Scheduled: a text-mode sentence has been "read" (its reading delay passed) -> played. */
export const textPlayJob = table(
  { name: 'text_play_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    sentenceId: t.u64(),
    utteranceId: t.u64(),
    idx: t.u32(),
  }
);

/** Reading clock of a text-mode session: when the last queued sentence of `utteranceId` ends
 *  (sentences are read one after another). Private. */
export const textPlayback = table(
  { name: 'text_playback' },
  {
    sessionId: t.u64().primaryKey(),
    utteranceId: t.u64(),
    endsAtMicros: t.u64(),
  }
);

// ---------------------------------------------------------------- team lesson planner (contract section 1)

/** The lesson canvas the learner sees: CanvasState JSON of the team's canvas compiler. Advances
 *  with every accepted beat and learner manipulation; rolled back to the last seen beat when a
 *  lesson is interrupted. */
export const canvasState = table(
  { name: 'canvas_state', public: true },
  {
    sessionId: t.u64().primaryKey(),
    version: t.u32(),
    scene: t.string(),
    updatedAt: t.timestamp(),
  }
);

/** One compiled and validated lesson moment (the team's VisualBeat): `visual` = the beat without
 *  narration ({id, cues:[{id, atMs, commands}]}), `narration` = its spoken text, revealed when
 *  reply_sentence (utteranceId, sentenceIdx) starts playing. */
export const beat = table(
  { name: 'beat', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    utteranceId: t.u64(),
    idx: t.u32(),
    visual: t.string(),
    narration: t.string(),
    sentenceIdx: t.i32(),
    /** canvas_state.version after this beat. */
    canvasVersion: t.u32(),
    createdAt: t.timestamp(),
  }
);

/** Canvas manipulation / picture submission / choice by the learner (submitInteraction). */
export const learnerEvent = table(
  { name: 'learner_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    kind: t.string(),
    payload: t.string(),
    accepted: t.bool(),
    /** JSON: the recorded Evidence item (submit/choice), the observation (manipulations), or {error}. */
    evidence: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Public view of the team's TeachingSession/TeachingPlanner state. */
export const lessonState = table(
  { name: 'lesson_state', public: true },
  {
    sessionId: t.u64().primaryKey(),
    /** needs_plan | presenting | awaiting_response | completed (TeachingPlanner status). */
    stage: t.string(),
    awaitingResponse: t.bool(),
    checkPrompt: t.string(),
    /** JSON Evidence[] (team contract). */
    evidence: t.string(),
    /** JSON {stepId, phase, learningGoal, approach, beatCount, check (public view, no answer), steps:[{id,phase,learningGoal,exampleProblem}]}. */
    notes: t.string(),
    updatedAt: t.timestamp(),
  }
);

/** Authoritative TeachingPlanner record (config, current step incl. its check, history, evidence). Private. */
export const lessonRecord = table(
  { name: 'lesson_record' },
  {
    sessionId: t.u64().primaryKey(),
    data: t.string(),
  }
);

/** A streamed lesson in progress (one per tutor utterance). Private. */
export const lessonPlan = table(
  { name: 'lesson_plan' },
  {
    utteranceId: t.u64().primaryKey(),
    sessionId: t.u64().index('btree'),
    /** JSON ModelRequest the lesson answers (validated at beginLesson). */
    request: t.string(),
    meta: t.string(),
    /** JSON VisualBeat[] accepted so far. */
    beats: t.string(),
    /** JSON CanvasState[]: [start, after beat 0, after beat 1, ...]. */
    scenes: t.string(),
    /** canvas_state.version after the last accepted beat (start version before any). */
    version: t.u32(),
    final: t.bool(),
  }
);

/** Worker heartbeat (replaces /api/teaching/status). Single row id 0. */
export const agentStatus = table(
  { name: 'agent_status', public: true },
  {
    id: t.u32().primaryKey(),
    model: t.string(),
    provider: t.string(),
    busySessions: t.u32(),
    lastSeen: t.timestamp(),
  }
);

/** Replaces /api/teaching/shear-feedback: client request row -> worker -> tutor_result. */
export const tutorRequest = table(
  { name: 'tutor_request', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    /** e.g. 'shear_feedback'. */
    kind: t.string(),
    payload: t.string(),
    /** pending | done | error */
    status: t.string(),
    createdAt: t.timestamp(),
  }
);

export const tutorResult = table(
  { name: 'tutor_result', public: true },
  {
    requestId: t.u64().primaryKey(),
    sessionId: t.u64().index('btree'),
    ok: t.bool(),
    /** JSON result, or the error message when !ok. */
    result: t.string(),
    createdAt: t.timestamp(),
  }
);
