// Scenario table for the E2E run. Each scenario = one test learner + one session in its own
// headless Chrome (the fake microphone is per browser), fed by one generated fixture WAV.

export const E2E_DEFAULTS = {
  db: process.env.E2E_DB || 'tutor-e2e',
  clientPort: Number(process.env.E2E_CLIENT_PORT || 5180),
  /** Extra client URL params for every session tab, e.g. `smart_turn=0&vad_turn_ms=900`. */
  clientQuery: (process.env.E2E_CLIENT_QUERY || '').replace(/^[?&]/, ''),
  moduleEnv: {
    STT_BASE_URL: process.env.E2E_STT_BASE_URL || 'https://api.cartesia.ai',
    CARTESIA_STT_MODEL: process.env.E2E_STT_MODEL || 'ink-whisper',
    MEMORY_EVERY_N_TURNS: '2',
  },
  /** Spec target for turn end -> first audio; above it is a warning, not a failure. */
  latencyTargetMs: 2500,
  /** Word recall of the fixture text in the transcript. */
  transcriptThreshold: 0.7,
  /** Barge-in -> local tutor audio stopped. */
  bargeInStopMs: 300,
};

export const TASK_TEXT = 'Expand 2/3 so the bottom number is 12.';

export interface Scenario {
  /** Unique name in the report. */
  id: string;
  /** Fixture name in e2e/fixtures (<name>.wav + <name>.json). */
  fixture: string;
  /** Student turns the fixture should produce (and tutor replies we wait for). */
  turns: number;
  /** Extra checks. */
  noisy?: boolean;
  interrupt?: boolean;
  /** All speech must stay in a single student turn (thinking pauses). */
  singleTurn?: boolean;
  /** Open an observer tab for this session and check that it mirrors it. */
  observer?: boolean;
  /** Max wait for the whole scenario after "start talking". */
  timeoutMs: number;
}

export interface Group {
  name: string;
  /** Run the scenarios of a group at the same time. */
  parallel: boolean;
  scenarios: Scenario[];
}

export const GROUPS: Group[] = [
  {
    name: 'single',
    parallel: false,
    scenarios: [
      { id: 'correct-step', fixture: 'correct-step', turns: 1, timeoutMs: 60_000 },
      { id: 'wrong-step', fixture: 'wrong-step', turns: 1, timeoutMs: 60_000 },
      { id: 'um-pauses', fixture: 'um-pauses', turns: 1, singleTurn: true, timeoutMs: 60_000 },
      { id: 'noisy', fixture: 'noisy', turns: 1, noisy: true, timeoutMs: 60_000 },
      { id: 'interrupt', fixture: 'interrupt', turns: 2, interrupt: true, timeoutMs: 90_000 },
    ],
  },
  {
    name: 'parallel',
    parallel: true,
    scenarios: [
      { id: 'par-correct-step', fixture: 'correct-step', turns: 1, observer: true, timeoutMs: 75_000 },
      { id: 'par-wrong-step', fixture: 'wrong-step', turns: 1, timeoutMs: 75_000 },
      { id: 'par-um-pauses', fixture: 'um-pauses', turns: 1, singleTurn: true, timeoutMs: 75_000 },
    ],
  },
];
