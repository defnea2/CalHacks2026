// Module environment access. Reads ctx.env (SpacetimeDB module env, set at publish) and
// treats missing/empty values as undefined. Unit tests have no env syscall, so they install
// an override map instead (setEnvOverride); in production the override is never set.
import { CLASSROOM_DEFAULTS, MODULE_DEFAULTS, PLAYBACK_DEFAULTS } from '../../shared/src/config';

export type EnvName =
  | 'CARTESIA_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'OPENROUTER_EXTRACTION_MODEL'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_EXTRACTION_MODEL'
  | 'MEMORY_PROVIDER'
  | 'AGENT_SECRET'
  | 'STT_BASE_URL'
  | 'CARTESIA_STT_MODEL'
  | 'CARTESIA_TTS_MODEL'
  | 'CARTESIA_VOICE_ID'
  | 'TTS_SAMPLE_RATE'
  | 'MEMORY_EVERY_N_TURNS'
  | 'SIM_MAX_TURNS'
  | 'DASHBOARD_INTERVAL_S'
  | 'DASHBOARD_EFFORT'
  | 'LESSON_ARC'
  | 'INSIGHTS_KEY'
  | 'RETENTION_IMAGE_MIN'
  | 'RETENTION_DAYS'
  | 'LLM_DISPATCH'
  | 'CF_DISPATCH_URL'
  | 'CF_DISPATCH_SECRET';

let override: Partial<Record<EnvName, string>> | null = null;

/** Tests only. */
export function setEnvOverride(values: Partial<Record<EnvName, string>> | null): void {
  override = values;
}

export function readEnv(ctx: { env: unknown }, name: EnvName): string | undefined {
  let v: unknown;
  if (override) v = override[name];
  else {
    try {
      v = (ctx.env as Record<string, unknown>)[name];
    } catch {
      v = undefined;
    }
  }
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function intEnv(ctx: { env: unknown }, name: EnvName, fallback: number): number {
  const n = Number(readEnv(ctx, name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const settings = {
  sttBaseUrl: (ctx: { env: unknown }) => (readEnv(ctx, 'STT_BASE_URL') ?? MODULE_DEFAULTS.STT_BASE_URL).replace(/\/+$/, ''),
  sttModel: (ctx: { env: unknown }) => readEnv(ctx, 'CARTESIA_STT_MODEL') ?? MODULE_DEFAULTS.CARTESIA_STT_MODEL,
  ttsModel: (ctx: { env: unknown }) => readEnv(ctx, 'CARTESIA_TTS_MODEL') ?? MODULE_DEFAULTS.CARTESIA_TTS_MODEL,
  voiceId: (ctx: { env: unknown }) => readEnv(ctx, 'CARTESIA_VOICE_ID') ?? MODULE_DEFAULTS.CARTESIA_VOICE_ID,
  ttsSampleRate: (ctx: { env: unknown }) => intEnv(ctx, 'TTS_SAMPLE_RATE', PLAYBACK_DEFAULTS.TTS_SAMPLE_RATE),
  memoryEveryN: (ctx: { env: unknown }) => intEnv(ctx, 'MEMORY_EVERY_N_TURNS', MODULE_DEFAULTS.MEMORY_EVERY_N_TURNS),
  cartesiaKey: (ctx: { env: unknown }) => readEnv(ctx, 'CARTESIA_API_KEY') ?? '',
  openrouterKey: (ctx: { env: unknown }) => readEnv(ctx, 'OPENROUTER_API_KEY') ?? '',
  extractionModel: (ctx: { env: unknown }) => readEnv(ctx, 'OPENROUTER_EXTRACTION_MODEL') ?? '',
  anthropicKey: (ctx: { env: unknown }) => readEnv(ctx, 'ANTHROPIC_API_KEY') ?? '',
  anthropicModel: (ctx: { env: unknown }) => readEnv(ctx, 'ANTHROPIC_EXTRACTION_MODEL') ?? MODULE_DEFAULTS.ANTHROPIC_EXTRACTION_MODEL,
  /** `anthropic` | `openrouter`; default anthropic when ANTHROPIC_API_KEY is set. */
  memoryProvider: (ctx: { env: unknown }): 'anthropic' | 'openrouter' => {
    const v = readEnv(ctx, 'MEMORY_PROVIDER')?.toLowerCase();
    if (v === 'anthropic' || v === 'openrouter') return v;
    return readEnv(ctx, 'ANTHROPIC_API_KEY') ? 'anthropic' : 'openrouter';
  },
  agentSecret: (ctx: { env: unknown }) => readEnv(ctx, 'AGENT_SECRET') ?? '',
  simMaxTurns: (ctx: { env: unknown }) => intEnv(ctx, 'SIM_MAX_TURNS', CLASSROOM_DEFAULTS.SIM_MAX_TURNS),
  dashboardIntervalS: (ctx: { env: unknown }) => intEnv(ctx, 'DASHBOARD_INTERVAL_S', CLASSROOM_DEFAULTS.DASHBOARD_INTERVAL_S),
  /** Thinking effort of the dashboard call (env DASHBOARD_EFFORT = low | medium | high). */
  /** `worker` (default: the Node worker answers) | `cloudflare` (the module dispatches each turn, dispatch.ts)
   *  | `manual` (local testing: dispatches are created but not POSTed; an agent takes them with takeDispatch). */
  llmDispatch: (ctx: { env: unknown }): 'worker' | 'cloudflare' | 'manual' => {
    const v = readEnv(ctx, 'LLM_DISPATCH')?.toLowerCase();
    return v === 'cloudflare' || v === 'manual' ? v : 'worker';
  },
  cfDispatchUrl: (ctx: { env: unknown }) => readEnv(ctx, 'CF_DISPATCH_URL') ?? '',
  cfDispatchSecret: (ctx: { env: unknown }) => readEnv(ctx, 'CF_DISPATCH_SECRET') ?? '',
  dashboardEffort: (ctx: { env: unknown }): 'low' | 'medium' | 'high' => {
    const v = readEnv(ctx, 'DASHBOARD_EFFORT')?.toLowerCase();
    return v === 'low' || v === 'medium' || v === 'high' ? v : (CLASSROOM_DEFAULTS.DASHBOARD_EFFORT as 'low' | 'medium' | 'high');
  },
};
