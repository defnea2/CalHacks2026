// SpacetimeDB schema: every table of the voice tutor. Owned by the lead (Stream 0);
// changes go through the lead, who regenerates bindings.
//
// Conventions
// - Timestamps are t.timestamp(); "unset" optional times use t.option(t.timestamp()).
// - Phase and board kind are plain strings, validated at runtime against the lesson pack.
// - List/JSON fields are JSON strings (spec "Content library").
// - Every lookup column is indexed.
import { schema, table, t } from 'spacetimedb/server';
import { textPlayJob, textPlayback, canvasState, beat, learnerEvent, lessonState, lessonRecord, lessonPlan, agentStatus, tutorRequest, tutorResult } from './schema_pipeline';
import * as classroom from './schema_classroom';
import * as dispatchTables from './schema_dispatch';

// ---------------------------------------------------------------- learners & sessions

export const learner = table(
  { name: 'learner', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    age: t.u32(),
    grade: t.u32(),
    /** e.g. "short hints, visuals first" */
    style: t.string(),
    createdAt: t.timestamp(),
    /** Classroom simulation user (night/classroom-core). */
    isSimulated: t.bool().default(false),
    /** Seed order 1..20 of a simulation user; 0 = real learner. */
    simRank: t.u32().default(0),
  }
);

export const session = table(
  { name: 'session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    learnerId: t.u64().index('btree'),
    /** Short human code shown in the header, e.g. "K7Q2". */
    code: t.string(),
    taskText: t.string(),
    phase: t.string(),
    turnState: t.string(),
    category: t.string(),
    concept: t.string(),
    packVersion: t.string(),
    active: t.bool().index('btree'),
    hasImage: t.bool(),
    /** Number of turns (student + tutor) appended so far; next turn idx. */
    turnCount: t.u32(),
    /** Utterance the tutor is currently speaking (0 = none). */
    currentUtteranceId: t.u64(),
    startedAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
    /** Linked class session (0 = ad-hoc). */
    classSessionId: t.u64().default(0n),
    /** false = text mode: no STT/TTS; sentences count as played after a reading delay. */
    voice: t.bool().default(true),
    /** A turn photo is waiting for the learner's next turn (no bytes; see turn_image). */
    pendingPhoto: t.bool().default(false),
  }
);

export const sessionImage = table(
  { name: 'session_image' },
  {
    sessionId: t.u64().primaryKey(),
    mime: t.string(),
    data: t.byteArray(),
  }
);

/** Photos taken during a session (private, <= 1 MB). At most one pending (bound = false) per
 *  session; closing the learner's next student turn binds it (turnIdx, usedAt) and the worker
 *  reads it for that turn via getTurnImage. */
export const turnImage = table(
  { name: 'turn_image' },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    learnerId: t.u64(),
    mime: t.string(),
    data: t.byteArray(),
    createdAt: t.timestamp(),
    bound: t.bool().default(false),
    turnIdx: t.u32().default(0),
    usedAt: t.option(t.timestamp()),
  }
);

/** Identity that started an ad-hoc session (private): only it may attach turn photos. */
export const sessionOwner = table(
  { name: 'session_owner' },
  {
    sessionId: t.u64().primaryKey(),
    owner: t.identity(),
  }
);

// ---------------------------------------------------------------- voice input

/** Buffered student audio (private). Joined by seq and transcribed in one request when the
 *  phrase's final chunk arrives; deleted once the phrase is transcribed. */
export const audioIn = table(
  {
    name: 'audio_in',
    indexes: [{ accessor: 'bySessionPhrase', algorithm: 'btree', columns: ['sessionId', 'phraseId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    phraseId: t.u32(),
    seq: t.u32(),
    pcm: t.byteArray(),
  }
);

/** Student speech activity (no audio). Event table: lets the worker abort preemptive
 *  generation as soon as the student speaks again. */
export const speechActivity = table(
  { name: 'speech_activity', public: true, event: true },
  {
    sessionId: t.u64(),
    phraseId: t.u32(),
    seq: t.u32(),
  }
);

/** One phrase of student speech (between short pauses). */
export const phrase = table(
  {
    name: 'phrase',
    public: true,
    indexes: [{ accessor: 'bySessionPhrase', algorithm: 'btree', columns: ['sessionId', 'phraseId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    phraseId: t.u32(),
    /** Student turn this phrase belongs to. */
    turnIdx: t.u32(),
    /** Highest seq received; repeated seqs are ignored. -1 = none yet. */
    lastSeq: t.i32(),
    /** Total PCM bytes received (16 kHz PCM16 -> 32 bytes per ms). */
    bytes: t.u32(),
    status: t.string(),
    text: t.string(),
    startedAt: t.timestamp(),
    finalAt: t.option(t.timestamp()),
    transcribedAt: t.option(t.timestamp()),
  }
);

export const turn = table(
  {
    name: 'turn',
    public: true,
    indexes: [{ accessor: 'bySessionIdx', algorithm: 'btree', columns: ['sessionId', 'idx'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    idx: t.u32(),
    role: t.string(),
    text: t.string(),
    status: t.string(),
    pendingPhrases: t.u32(),
    /** Tutor turns: the utterance id. Student turns: 0. */
    utteranceId: t.u64(),
    /** Tutor turns cut short by barge-in. */
    interrupted: t.bool(),
    createdAt: t.timestamp(),
    closedAt: t.option(t.timestamp()),
    /** 'voice' | 'text' | 'sim' (TURN_SOURCES). */
    source: t.string().default('voice'),
    /** '' or a lesson intent of the team UI (TURN_INTENTS). */
    intent: t.string().default(''),
    /** Student turns: a photo (turn_image) was sent with this turn. */
    hasPhoto: t.bool().default(false),
  }
);

// ---------------------------------------------------------------- voice output

export const replySentence = table(
  {
    name: 'reply_sentence',
    public: true,
    indexes: [{ accessor: 'byUtteranceIdx', algorithm: 'btree', columns: ['utteranceId', 'idx'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    utteranceId: t.u64(),
    idx: t.u32(),
    display: t.string(),
    speech: t.string(),
    status: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Synthesized audio for one sentence. Event table. */
export const audioOut = table(
  { name: 'audio_out', public: true, event: true },
  {
    sessionId: t.u64(),
    utteranceId: t.u64(),
    idx: t.u32(),
    pcm: t.byteArray(),
    sampleRate: t.u32(),
    /** Word timestamps from TTS (ms from the start of `pcm`), parallel arrays; empty when the
     *  provider gave none. Words are the whitespace-separated tokens of the sentence speech. */
    words: t.array(t.string()),
    wordStartsMs: t.array(t.u32()),
    wordEndsMs: t.array(t.u32()),
  }
);

/** Tells every client of a session to flush its playback queue. Event table. */
export const playbackFlush = table(
  { name: 'playback_flush', public: true, event: true },
  {
    sessionId: t.u64(),
    utteranceId: t.u64(),
  }
);

// ---------------------------------------------------------------- board

export const boardItem = table(
  { name: 'board_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    idx: t.u32(),
    kind: t.string(),
    /** JSON content for the kind's renderer. */
    content: t.string(),
    phase: t.string(),
    visible: t.bool(),
    /** Reveal when this sentence of this utterance starts playing (0/0 = immediately). */
    utteranceId: t.u64(),
    sentenceIdx: t.u32(),
    taskKey: t.string(),
    /** Gap tasks: open | correct | wrong. Other kinds: ''. */
    answerState: t.string(),
    lastAnswer: t.string(),
    createdAt: t.timestamp(),
    /** Inline marker anchor: character offset in the speech of sentence (utteranceId,
     *  sentenceIdx) where the item appears (at the word there). -1 = no marker: reveal when the
     *  sentence starts playing. */
    markerPos: t.i32().default(-1),
  }
);

export const boardAnswer = table(
  { name: 'board_answer' },
  {
    boardItemId: t.u64().primaryKey(),
    /** JSON ExpectedAnswer. */
    answer: t.string(),
  }
);

// ---------------------------------------------------------------- metrics & roles

export const turnMetrics = table(
  {
    name: 'turn_metrics',
    public: true,
    indexes: [{ accessor: 'bySessionTurn', algorithm: 'btree', columns: ['sessionId', 'turnIdx'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    /** Student turn idx the reply answers. */
    turnIdx: t.u32(),
    utteranceId: t.u64(),
    turnEndAt: t.option(t.timestamp()),
    sttDoneAt: t.option(t.timestamp()),
    llmFirstTokenAt: t.option(t.timestamp()),
    firstSentenceAt: t.option(t.timestamp()),
    firstAudioAt: t.option(t.timestamp()),
    firstPlaybackAt: t.option(t.timestamp()),
    noiseDb: t.f64(),
    preemptive: t.bool(),
  }
);

export const role = table(
  { name: 'role' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
  }
);

// ---------------------------------------------------------------- scheduled jobs

export const sttJob = table(
  { name: 'stt_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    phraseId: t.u32(),
    attempt: t.u32(),
  }
);

export const ttsJob = table(
  { name: 'tts_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    sentenceId: t.u64(),
    utteranceId: t.u64(),
    idx: t.u32(),
    speech: t.string(),
  }
);

export const extractionJob = table(
  { name: 'extraction_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    learnerId: t.u64(),
    /** Turn idx range [fromIdx, toIdx). */
    fromIdx: t.u32(),
    toIdx: t.u32(),
    attempt: t.u32(),
  }
);

export const summaryJob = table(
  { name: 'summary_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64(),
    learnerId: t.u64(),
    attempt: t.u32(),
  }
);

// ---------------------------------------------------------------- learner memory (private)

export const memoryNote = table(
  { name: 'memory_note' },
  {
    id: t.u64().primaryKey().autoInc(),
    learnerId: t.u64().index('btree'),
    kind: t.string(),
    category: t.string(),
    concept: t.string(),
    text: t.string(),
    outcome: t.string(),
    confidence: t.f64(),
    /** How often later windows confirmed it. */
    reinforced: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

export const noteEvidence = table(
  { name: 'note_evidence' },
  {
    id: t.u64().primaryKey().autoInc(),
    noteId: t.u64().index('btree'),
    sessionId: t.u64(),
    fromTurn: t.u32(),
    toTurn: t.u32(),
    quote: t.string(),
  }
);

export const conceptState = table(
  {
    name: 'concept_state',
    indexes: [{ accessor: 'byLearnerConcept', algorithm: 'btree', columns: ['learnerId', 'concept'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    learnerId: t.u64().index('btree'),
    category: t.string(),
    concept: t.string(),
    /** 0..100 */
    mastery: t.u32(),
    updatedAt: t.timestamp(),
  }
);

export const sessionSummary = table(
  { name: 'session_summary' },
  {
    sessionId: t.u64().primaryKey(),
    learnerId: t.u64().index('btree'),
    summary: t.string(),
    nextFocus: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Seeded "earlier sessions" (seed.ts): task and topic of a pseudo session id
 *  (>= SEED_SESSION_BASE) that has no session row. Its summary is in session_summary. */
export const seedSession = table(
  { name: 'seed_session' },
  {
    sessionId: t.u64().primaryKey(),
    learnerId: t.u64().index('btree'),
    taskText: t.string(),
    category: t.string(),
    concept: t.string(),
    startedAt: t.timestamp(),
  }
);

export const extractionCursor = table(
  { name: 'extraction_cursor' },
  {
    sessionId: t.u64().primaryKey(),
    /** First turn idx not yet processed. */
    nextIdx: t.u32(),
    /** Unix micros when an extractMemory run took the window (0 = idle). While set, no new
     *  window is scheduled (the job row is gone during the LLM call). */
    runningSinceMicros: t.u64().default(0n),
  }
);

// ---------------------------------------------------------------- content library (public, read-only)

export const category = table(
  { name: 'category', public: true },
  {
    key: t.string().primaryKey(),
    title: t.string(),
    position: t.u32(),
  }
);

export const concept = table(
  { name: 'concept', public: true },
  {
    key: t.string().primaryKey(),
    category: t.string().index('btree'),
    title: t.string(),
    language: t.string(),
    gradeBand: t.string(),
    /** JSON string[] */
    dependsOn: t.string(),
    summary: t.string(),
  }
);

export const skill = table(
  { name: 'skill', public: true },
  {
    key: t.string().primaryKey(),
    concept: t.string().index('btree'),
    position: t.u32(),
    title: t.string(),
    kind: t.string(),
    /** JSON StepDef[] */
    steps: t.string(),
    keyStepIndex: t.u32(),
    commonMistake: t.string(),
    tutorNote: t.string(),
  }
);

export const explanation = table(
  { name: 'explanation', public: true },
  {
    id: t.string().primaryKey(),
    concept: t.string().index('btree'),
    skill: t.string(),
    kind: t.string(),
    say: t.string(),
    /** JSON LibraryBoardItem[] */
    boardItems: t.string(),
  }
);

export const task = table(
  { name: 'task', public: true },
  {
    key: t.string().primaryKey(),
    skill: t.string().index('btree'),
    concept: t.string().index('btree'),
    type: t.string(),
    difficulty: t.u32(),
    show: t.string(),
    say: t.string(),
    /** JSON {form, value} */
    answer: t.string(),
    /** JSON TaskStep[] */
    steps: t.string(),
    wrongStepIndex: t.i32(),
  }
);

export const libraryMeta = table(
  { name: 'library_meta' },
  {
    id: t.u32().primaryKey(),
    packVersion: t.string(),
  }
);

const spacetimedb = schema(
  {
    learner,
    session,
    sessionImage,
    turnImage,
    sessionOwner,
    audioIn,
    speechActivity,
    phrase,
    turn,
    replySentence,
    audioOut,
    playbackFlush,
    boardItem,
    boardAnswer,
    turnMetrics,
    role,
    sttJob,
    ttsJob,
    extractionJob,
    summaryJob,
    memoryNote,
    noteEvidence,
    conceptState,
    sessionSummary,
    seedSession,
    extractionCursor,
    category,
    concept,
    skill,
    explanation,
    task,
    libraryMeta,
    ...classroom,
    textPlayJob,
    textPlayback,
    canvasState,
    beat,
    learnerEvent,
    lessonState,
    lessonRecord,
    lessonPlan,
    agentStatus,
    tutorRequest,
    tutorResult,
    ...dispatchTables,
  },
  {
    env: {
      CARTESIA_API_KEY: t.string(),
      OPENROUTER_API_KEY: t.string(),
      /** Model for memory extraction / summaries (defaults to OPENROUTER_MODEL at publish). */
      OPENROUTER_EXTRACTION_MODEL: t.string(),
      /** Shared secret the worker presents to registerAgent. */
      AGENT_SECRET: t.string(),
      /** Base URL for batch STT. Default http://127.0.0.1:8787 (stt-proxy, see README). */
      STT_BASE_URL: t.option(t.string()),
      CARTESIA_STT_MODEL: t.option(t.string()),
      CARTESIA_TTS_MODEL: t.option(t.string()),
      CARTESIA_VOICE_ID: t.option(t.string()),
      TTS_SAMPLE_RATE: t.option(t.string()),
      MEMORY_EVERY_N_TURNS: t.option(t.string()),
      /** Memory extraction / summaries via the Anthropic Messages API (Claude Haiku 5.5). */
      ANTHROPIC_API_KEY: t.option(t.string()),
      /** Default claude-haiku-5-5. */
      ANTHROPIC_EXTRACTION_MODEL: t.option(t.string()),
      /** anthropic | openrouter (default: anthropic when ANTHROPIC_API_KEY is set). */
      MEMORY_PROVIDER: t.option(t.string()),
      /** Classroom simulation: max simulated student turns per session per run (default 8). */
      SIM_MAX_TURNS: t.option(t.string()),
      /** Teacher dashboard refresh interval in seconds (default 30). */
      DASHBOARD_INTERVAL_S: t.option(t.string()),
      /** Teacher dashboard LLM thinking effort: low | medium | high (default low). */
      DASHBOARD_EFFORT: t.option(t.string()),
      /** Lesson arc of new sessions: a pack arc id (default demo2min) or `adaptive` (no arc). */
      LESSON_ARC: t.option(t.string()),
      /** Optional key the teacher's student-profile read (learnerInsights) must present. Unset = teacher id only. */
      INSIGHTS_KEY: t.option(t.string()),
      /** worker (default) | cloudflare: who answers student turns (docs/CLOUD_PLAN.md Part B). */
      LLM_DISPATCH: t.option(t.string()),
      /** Cloudflare dispatch: https://<worker>.workers.dev/dispatch. */
      CF_DISPATCH_URL: t.option(t.string()),
      /** Cloudflare dispatch: HMAC-SHA256 key shared with the Cloudflare Worker. */
      CF_DISPATCH_SECRET: t.option(t.string()),
    },
  }
);
export default spacetimedb;
