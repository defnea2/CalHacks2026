// Shared types and provider interfaces. Pure TypeScript: no Node or browser APIs,
// so the SpacetimeDB module, the worker and the client can all import this file.

export const TURN_STATES = ['listening', 'thinking', 'speaking', 'interrupted'] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const TURN_ROLES = ['student', 'tutor'] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

/** open: phrases still arriving; closing: endTurn called, waiting for pending phrases;
 *  ready: complete student turn, worker may answer; done: answered (or tutor turn finished). */
export const TURN_STATUSES = ['open', 'closing', 'ready', 'done'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** streaming: audio chunks arriving; transcribing: final chunk seen, waiting for text;
 *  done: text appended to its turn; discarded: too short or empty transcript. */
export const PHRASE_STATUSES = ['streaming', 'transcribing', 'done', 'discarded'] as const;
export type PhraseStatus = (typeof PHRASE_STATUSES)[number];

/** pending: waiting for TTS; ready: audio_out emitted; played: client started playing it;
 *  dropped: interrupted before it played. */
export const SENTENCE_STATUSES = ['pending', 'ready', 'played', 'dropped'] as const;
export type SentenceStatus = (typeof SENTENCE_STATUSES)[number];

export const MEMORY_KINDS = ['misconception', 'strategy', 'mnemonic', 'quote', 'understood', 'preference'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_OUTCOMES = ['worked', 'didnt', 'unknown'] as const;
export type MemoryOutcome = (typeof MEMORY_OUTCOMES)[number];

export const GAP_STATES = ['open', 'correct', 'wrong'] as const;
export type GapState = (typeof GAP_STATES)[number];

/** Metric names accepted by the recordMetric reducer (columns of turn_metrics). */
export const METRIC_NAMES = ['turnEndAt', 'sttDoneAt', 'llmFirstTokenAt', 'firstSentenceAt', 'firstAudioAt', 'firstPlaybackAt'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** Answer stored privately for automatic checking (board_answer, library task answers). */
export interface ExpectedAnswer {
  form: 'number' | 'fraction' | 'choice' | 'text';
  /** For `fraction`: "3/6". For `number`: "3" or "0.5". For `choice`: the option text. */
  value: string;
}

// ---------------------------------------------------------------------------
// Provider interfaces (LiveKit-style components). Each provider can move between
// runtimes (module procedure vs worker) without touching the rest.
// ---------------------------------------------------------------------------

/** One phrase of PCM16 mono in, text out. Runs in a SpacetimeDB procedure (one-shot request
 *  to the Cartesia batch STT interface, served locally by stt-proxy -> ink-2; README check #3). */
export interface SttRequest {
  pcm: Uint8Array;
  sampleRate: number;
  model: string;
  language: string;
}
export interface SttResult {
  text: string;
  durationS: number;
}

/** One sentence in, complete PCM16 audio out. Runs in a SpacetimeDB procedure. */
export interface TtsRequest {
  text: string;
  voiceId: string;
  model: string;
  sampleRate: number;
  speed: number;
  language: string;
}
export interface TtsResult {
  pcm: Uint8Array;
  sampleRate: number;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as streamed by the model. */
  arguments: string;
}
export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  name?: string;
}
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** Events streamed by an LlmProvider, in order. */
export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'done'; finishReason: string };

export interface LlmProvider {
  stream(opts: { messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): AsyncIterable<LlmEvent>;
}
