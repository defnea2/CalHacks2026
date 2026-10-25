// The worker's view of SpacetimeDB: reducer/procedure calls up (Transport) and the row shapes
// it reads from subscriptions. The real implementation is stdb.ts; tests use a fake.
import type { MetricName } from '@tutor/shared';

export interface SessionRow {
  id: bigint;
  taskText: string;
  phase: string;
  turnState: string;
  active: boolean;
  hasImage: boolean;
  currentUtteranceId: bigint;
  /** Turns appended so far (0 = nothing said yet: the tutor may open). */
  turnCount: number;
  /** false = text mode (no STT/TTS); absent = voice. */
  voice?: boolean;
  /** Read for context-prefetch invalidation (topic, learner). */
  category?: string;
  concept?: string;
  learnerId?: bigint;
  /** Tells a new session from an old one with the same id (ids restart after a cleared database). */
  startedAt?: { microsSinceUnixEpoch: bigint };
}

export interface TurnRow {
  sessionId: bigint;
  idx: number;
  role: string;
  text: string;
  status: string;
  utteranceId: bigint;
  interrupted: boolean;
  /** 'voice' | 'text' | 'sim' (absent in old rows/tests = voice). */
  source?: string;
  /** '' or a lesson button intent (another_way | smaller_step | continue | demonstrate). */
  intent?: string;
}

export interface PhraseRow {
  sessionId: bigint;
  phraseId: number;
  turnIdx: number;
  status: string;
  text: string;
}

export interface SentenceRow {
  sessionId: bigint;
  utteranceId: bigint;
  idx: number;
  status: string;
}

/** Calls the worker makes. Reducer promises reject on reducer errors. */
export interface Transport {
  beginUtterance(a: { sessionId: bigint; utteranceId: bigint; replyToIdx: number; preemptive: boolean }): Promise<void>;
  /** The tutor's opening utterance (after the client's startConversation; no student turn). */
  beginOpening(a: { sessionId: bigint; utteranceId: bigint }): Promise<void>;
  addSentence(a: { sessionId: bigint; utteranceId: bigint; idx: number; display: string; speech: string }): Promise<void>;
  appendTutorTurn(a: { sessionId: bigint; utteranceId: bigint; text: string; interrupted: boolean }): Promise<void>;
  recordMetric(a: { sessionId: bigint; turnIdx: number; name: MetricName; atMicros: bigint }): Promise<void>;
  setPhase(a: { sessionId: bigint; phase: string; reason: string }): Promise<void>;
  showBoardItem(a: {
    sessionId: bigint;
    utteranceId: bigint;
    sentenceIdx: number;
    /** Offset of the item's inline marker in the speech of sentence sentenceIdx; -1 = none. */
    markerPos: number;
    kind: string;
    content: string;
    taskKey: string;
    expectedAnswer: string;
  }): Promise<void>;
  clearBoard(a: { sessionId: bigint }): Promise<void>;
  remember(a: { sessionId: bigint; kind: string; category: string; concept: string; text: string; outcome: string }): Promise<void>;
  buildContext(a: { sessionId: bigint }): Promise<string>;
  setTopic(a: { sessionId: bigint; category: string; concept: string }): Promise<string>;
  getSessionImage(a: { sessionId: bigint }): Promise<string>;
  // ---- team lesson planner (contract section 1)
  /** JSON {ok: true, request: ModelRequest} | {ok: false, error}. */
  buildLessonRequest(a: { sessionId: bigint; requestId: string }): Promise<string>;
  /** Topic prefetch (keyword cues in the module): JSON {ok, category, concept, source, text, hasImage}. */
  prefetchTopic(a: { sessionId: bigint }): Promise<string>;
  beginLesson(a: { sessionId: bigint; utteranceId: bigint; meta: string }): Promise<void>;
  addBeat(a: { sessionId: bigint; utteranceId: bigint; idx: number; visual: string; narration: string }): Promise<void>;
  agentHeartbeat(a: { model: string; provider: string; busySessions: number }): Promise<void>;
  submitTutorResult(a: { requestId: bigint; ok: boolean; result: string }): Promise<void>;
}
