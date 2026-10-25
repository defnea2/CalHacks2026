// Loads the root .env and .env.local (AGENT_SECRET), same format as scripts/env.mjs.
// In a git worktree the root may lack .env; then the nearest parent directory that has one is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_DEFAULTS } from '@tutor/shared';

export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(WORKER_DIR, '..');

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readEnvFile(file: string): Record<string, string> {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

/** Directory holding .env or .env.local: prefer this checkout before searching ancestors. */
export function findEnvDir(start = REPO_ROOT): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.env')) || fs.existsSync(path.join(dir, '.env.local'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

export interface WorkerConfig {
  spacetimeUri: string;
  spacetimeDb: string;
  agentSecret: string;
  /** `anthropic` (default when ANTHROPIC_API_KEY is set) or `openrouter`. */
  llmProvider: 'anthropic' | 'openrouter';
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  anthropicThinking: 'adaptive' | 'disabled';
  openrouterApiKey: string;
  openrouterModel: string;
  reasoningEffort: string;
  preemptive: boolean;
  preemptiveSilenceMs: number;
  maxToolRounds: number;
  recentTurns: number;
  toolTimeoutMs: number;
  tokenFile: string;
  /** lesson (team streaming planner, default) | tools (tool loop with show_board_item). */
  replyMode: 'lesson' | 'tools';
  /** output_config.effort for lesson mode (default low: measured faster, same rejection rate). */
  lessonEffort: 'low' | 'medium' | 'high';
  /** Worker heartbeat period (agent_status). */
  heartbeatMs: number;
  /** lesson (default): the opening is the authored lead-in + the first lesson in one utterance
   *  (the tutor owns the explanation from the start); script: the authored opening only. */
  lessonOpening: 'lesson' | 'script';
  /** Library index in the planner system prompt + the prefetched concept's material (default on). */
  lessonLibrary: boolean;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : !/^(0|false|off|no)$/i.test(v));
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/** Merged config: process env overrides .env.local overrides .env, then WORKER_DEFAULTS. */
export function loadConfig(): WorkerConfig {
  const dir = findEnvDir();
  const env: Record<string, string | undefined> = {
    ...readEnvFile(path.join(dir, '.env')),
    ...readEnvFile(path.join(dir, '.env.local')),
    ...process.env,
  };
  return {
    spacetimeUri: env.SPACETIME_URI || 'ws://127.0.0.1:3000',
    spacetimeDb: env.SPACETIME_DB || 'voice-tutor',
    agentSecret: env.AGENT_SECRET ?? '',
    llmProvider: (env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'openrouter')) === 'openrouter' ? 'openrouter' : 'anthropic',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    anthropicEffort: (env.ANTHROPIC_EFFORT as WorkerConfig['anthropicEffort']) || 'medium',
    // Thinking off measured 0.3-0.5 s faster to first token on Haiku 5.5 at effort low; tool calls still work.
    anthropicThinking: env.ANTHROPIC_THINKING === 'adaptive' ? 'adaptive' : 'disabled',
    openrouterApiKey: env.OPENROUTER_API_KEY ?? '',
    openrouterModel: env.OPENROUTER_MODEL ?? '',
    reasoningEffort: env.LLM_REASONING_EFFORT || WORKER_DEFAULTS.LLM_REASONING_EFFORT,
    preemptive: bool(env.PREEMPTIVE_LLM, WORKER_DEFAULTS.PREEMPTIVE_LLM),
    preemptiveSilenceMs: num(env.PREEMPTIVE_SILENCE_MS, WORKER_DEFAULTS.PREEMPTIVE_SILENCE_MS),
    maxToolRounds: num(env.MAX_TOOL_ROUNDS, WORKER_DEFAULTS.MAX_TOOL_ROUNDS),
    recentTurns: num(env.RECENT_TURNS, WORKER_DEFAULTS.RECENT_TURNS),
    toolTimeoutMs: num(env.TOOL_TIMEOUT_MS, WORKER_DEFAULTS.TOOL_TIMEOUT_MS),
    // Relative paths are taken from the repo root: `pnpm --filter worker start` runs in worker/,
    // so `AGENT_TOKEN_FILE=worker/.agent-token.maincloud` would otherwise point at worker/worker/.
    tokenFile: env.AGENT_TOKEN_FILE ? path.resolve(REPO_ROOT, env.AGENT_TOKEN_FILE) : path.join(WORKER_DIR, '.agent-token'),
    replyMode: env.REPLY_MODE === 'tools' ? 'tools' : 'lesson',
    lessonEffort: (['low', 'medium', 'high'].includes(env.LESSON_EFFORT ?? '') ? env.LESSON_EFFORT : 'low') as WorkerConfig['lessonEffort'],
    heartbeatMs: num(env.HEARTBEAT_MS, 5000),
    lessonOpening: env.LESSON_OPENING === 'script' ? 'script' : 'lesson',
    lessonLibrary: bool(env.LESSON_LIBRARY, true),
  };
}
