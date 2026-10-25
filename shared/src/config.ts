// All tunable settings with their spec defaults. Secrets are never here: the module reads
// them from its SpacetimeDB environment, the worker from the root .env.

export const VOICE_DEFAULTS = {
  /** Microphone capture rate sent to SpacetimeDB and the STT stream. */
  INPUT_SAMPLE_RATE: 16000,
  AUDIO_CHUNK_MS: 150,
  VAD_THRESHOLD: 0.5,
  /** Speech this long confirms a phrase start (2 Silero frames of 32 ms). In `noisy` state
   *  NOISY_MIN_SPEECH_MS applies instead; the energy gate filters steady noise. */
  VAD_MIN_SPEECH_MS: 50,
  VAD_PREROLL_MS: 300,
  VAD_PHRASE_MS: 300,
  /** Silence after the last phrase that ends the student turn. 900 ms: thinking pauses of
   *  ~0.6 s stay in one turn, and the preemptive LLM call (PREEMPTIVE_SILENCE_MS after the
   *  end of speech) gets ~700 ms of head start before the turn is ready. */
  VAD_TURN_MS: 900,
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
  /** Semantic turn end (Pipecat Smart Turn v3, in the browser): 1 = on, 0 = silence only. */
  SMART_TURN: 1,
  /** P(turn complete) at or above this ends the turn early (model's own cut-off: 0.5). */
  SMART_TURN_THRESHOLD: 0.5,
  /** A "complete" verdict ends the turn once this much silence has passed (else VAD_TURN_MS).
   *  Must exceed a ~600 ms thinking pause PLUS the speech-start detection lag (~60-130 ms):
   *  at 600 ms a 590 ms pause ended the turn 70 ms before speech_start fired (E2E par-um-pauses). */
  SMART_TURN_MIN_SILENCE_MS: 750,
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
  /** Silence after the END OF SPEECH before the worker starts the LLM preemptively (output is
   *  held until the turn is ready; aborted and thrown away if the student goes on or the
   *  transcript changes). The worker learns of the speech end from the phrase's final chunk,
   *  which arrives VAD_PHRASE_MS after it, so it waits max(0, this - VAD_PHRASE_MS) from there,
   *  and only once every phrase of the turn is transcribed. Short on purpose: wasted LLM calls
   *  are accepted for latency. */
  PREEMPTIVE_SILENCE_MS: 200,
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
  /** Background JSON calls (memory extraction, session summary): Claude Haiku 5.5 via the
   *  Anthropic Messages API. MEMORY_PROVIDER env picks `anthropic` | `openrouter`; unset means
   *  anthropic when ANTHROPIC_API_KEY is set, else openrouter. */
  ANTHROPIC_EXTRACTION_MODEL: 'claude-haiku-5-5',
  ANTHROPIC_TIMEOUT_MS: 60_000,
  /** output_config.effort per task (thinking depth; tokens count toward max_tokens). */
  EXTRACTION_EFFORT: 'medium',
  EXTRACTION_MAX_TOKENS: 8000,
  SUMMARY_EFFORT: 'low',
  SUMMARY_MAX_TOKENS: 4000,
  CARTESIA_TTS_MODEL: 'sonic-3.6',
  CARTESIA_STT_MODEL: 'ink-2',
  /** Local batch-STT endpoint (stt-proxy). */
  STT_BASE_URL: 'http://127.0.0.1:8787',
  /** "Parker": casual, supportive warmth. Child-friendly tutor voice. */
  CARTESIA_VOICE_ID: '30894953-bcce-41fe-892c-15ce19c843ff',
  CARTESIA_VERSION: '2026-08-14',
  /** TTS via POST /tts/sse with add_timestamps (word timings for inline board markers);
   *  false: POST /tts/bytes, no word timings. */
  TTS_WORD_TIMESTAMPS: true,
  TTS_SPEED: 1.0,
  TTS_LANGUAGE: 'en',
  /** Max board item content size (JSON chars). */
  BOARD_CONTENT_MAX: 4000,
  /** Max photo size after client compression. */
  PHOTO_MAX_BYTES: 1_000_000,
  /** Text mode (session.voice = false): a sentence counts as played after this reading time
   *  per word (no TTS), so turn states still flow thinking -> speaking -> listening. */
  TEXT_SENTENCE_MS_PER_WORD: 280,
  /** Lower bound of one sentence's reading time. */
  TEXT_SENTENCE_MIN_MS: 700,
  /** Max typed student turn length. */
  TEXT_TURN_MAX_CHARS: 2000,
} as const;

/** "Daisy": very young voice used only for generated test-student speech. */
export const TEST_STUDENT_VOICE_ID = '32b3f3c5-7171-46aa-abe7-b598964aa793';

export type VoiceConfig = { -readonly [K in keyof typeof VOICE_DEFAULTS]: (typeof VOICE_DEFAULTS)[K] };
