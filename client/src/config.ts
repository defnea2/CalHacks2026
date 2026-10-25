// Runtime config: shared defaults, overridable per tab through URL query params.
// Every VAD/noise/playback key can be overridden by its lower-case name, e.g.
// ?vad_turn_ms=900&barge_in_threshold=0.8&sentence_pause_ms=150 (used by the E2E harness).
import { PLAYBACK_DEFAULTS, VOICE_DEFAULTS } from '@tutor/shared';

/** Client-only tuning knobs that the spec leaves open. Overridable the same way. */
export const CLIENT_DEFAULTS = {
  /** Silence inside a not-yet-confirmed speech start that cancels it (filters clicks). */
  VAD_CANDIDATE_GAP_MS: 96,
  /** Once a phrase is open, a frame still counts as speech above threshold - this (hysteresis). */
  VAD_HYSTERESIS: 0.15,
  /** Frames below this speech probability feed the noise floor. */
  NOISE_FLOOR_MAX_PROB: 0.3,
  /** Wait this long for a missing sentence index before skipping it. */
  PLAYBACK_GAP_TIMEOUT_MS: 6000,
  /** Lead time when scheduling the first block of a burst. */
  PLAYBACK_LEAD_MS: 40,
  /** Silero model: v5 (32 ms frames) or legacy (96 ms frames). */
  VAD_MODEL: 'v5' as 'v5' | 'legacy',
};

export type VoiceSettings = { -readonly [K in keyof typeof VOICE_DEFAULTS]: number };
export type PlaybackSettings = { -readonly [K in keyof typeof PLAYBACK_DEFAULTS]: number };
export type ClientSettings = typeof CLIENT_DEFAULTS;

export interface AppSettings {
  voice: VoiceSettings;
  playback: PlaybackSettings;
  client: ClientSettings;
  spacetimeUri: string;
  spacetimeDb: string;
}

function overrideNumbers<T extends Record<string, unknown>>(defaults: T, params: URLSearchParams): T {
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const raw = params.get(key.toLowerCase()) ?? params.get(key);
    if (raw === null) continue;
    if (typeof defaults[key] === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof defaults[key] === 'string') {
      out[key] = raw;
    }
  }
  return out as T;
}

export function loadSettings(search: string, env: Record<string, string | undefined> = {}): AppSettings {
  const params = new URLSearchParams(search);
  return {
    voice: overrideNumbers({ ...VOICE_DEFAULTS } as VoiceSettings, params),
    playback: overrideNumbers({ ...PLAYBACK_DEFAULTS } as PlaybackSettings, params),
    client: overrideNumbers({ ...CLIENT_DEFAULTS }, params),
    spacetimeUri: params.get('uri') ?? env.VITE_SPACETIME_URI ?? 'ws://127.0.0.1:3000',
    spacetimeDb: params.get('db') ?? env.VITE_SPACETIME_DB ?? 'tutor',
  };
}
