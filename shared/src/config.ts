// All tunable settings with their spec defaults. Secrets are never here: the module reads
// them from its SpacetimeDB environment, the worker from the root .env.

export const VOICE_DEFAULTS = {
  /** Microphone capture rate sent to SpacetimeDB and the STT stream. */
  INPUT_SAMPLE_RATE: 16000,
  AUDIO_CHUNK_MS: 150,
  VAD_THRESHOLD: 0.5,
  VAD_MIN_SPEECH_MS: 100,
  VAD_PREROLL_MS: 300,
  VAD_PHRASE_MS: 300,
  VAD_TURN_MS: 700,
  VAD_MAX_PHRASE_MS: 15000,
  BARGE_IN_THRESHOLD: 0.7,
  BARGE_IN_MIN_MS: 400,
  /** Speech may only start this many dB above the noise floor. */
  NOISE_SNR_DB: 10,
  /** Floor below this is `quiet`, above NOISE_NOISY_DBFS is `noisy`. */
  NOISE_QUIET_DBFS: -50,
  NOISE_NOISY_DBFS: -35,
  NOISE_FLOOR_TAU_MS: 2000,
  NOISE_SEED_MS: 1000,
  /** In `noisy` state: threshold += this, min speech = NOISY_MIN_SPEECH_MS. */
  NOISY_THRESHOLD_BOOST: 0.1,
  NOISY_MIN_SPEECH_MS: 200,
} as const;

export const PLAYBACK_DEFAULTS = {
  TTS_SAMPLE_RATE: 24000,
  FADE_MS: 8,
  SENTENCE_PAUSE_MS: 200,
  /** Samples below this absolute level (of 32768) count as silence when trimming. */
  TRIM_SILENCE_LEVEL: 200,
} as const;

export const WORKER_DEFAULTS = {
  PREEMPTIVE_LLM: true,
  PREEMPTIVE_SILENCE_MS: 400,
  MAX_TOOL_ROUNDS: 2,
  /** OpenRouter reasoning effort; `none` measured fastest first token (First check #5). */
  LLM_REASONING_EFFORT: 'none',
  RECENT_TURNS: 12,
  TOOL_TIMEOUT_MS: 5000,
} as const;

export const MODULE_DEFAULTS = {
  MEMORY_EVERY_N_TURNS: 6,
  /** Retry delays for extraction after an HTTP error; stop after the last. */
  EXTRACTION_RETRY_S: [10, 30, 90],
  MEMORY_MIN_CONFIDENCE: 0.7,
  CARTESIA_TTS_MODEL: 'sonic-3.6',
  CARTESIA_STT_MODEL: 'ink-2',
  /** "Parker": casual, supportive warmth. Child-friendly tutor voice. */
  CARTESIA_VOICE_ID: '30894953-bcce-41fe-892c-15ce19c843ff',
  CARTESIA_VERSION: '2026-08-14',
  TTS_SPEED: 1.0,
  TTS_LANGUAGE: 'en',
  /** Max board item content size (JSON chars). */
  BOARD_CONTENT_MAX: 4000,
  /** Max photo size after client compression. */
  PHOTO_MAX_BYTES: 1_000_000,
} as const;

/** "Daisy": very young voice used only for generated test-student speech. */
export const TEST_STUDENT_VOICE_ID = '32b3f3c5-7171-46aa-abe7-b598964aa793';

export type VoiceConfig = { -readonly [K in keyof typeof VOICE_DEFAULTS]: (typeof VOICE_DEFAULTS)[K] };
