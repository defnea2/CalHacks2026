// Publishes the module, passing secrets as SpacetimeDB module env (shell variables override .env
// and spacetime.json).
//
// Usage: node scripts/publish.mjs [--clear] [--dry-run] [--yes-remote] [--yes-delete-remote-data]
//
//   SPACETIME_SERVER  `local` (default) or e.g. `maincloud` (needs `spacetime login`)
//   SPACETIME_DB      database name (default voice-tutor)
//
// A non-local server needs --yes-remote; --clear on it also needs --yes-delete-remote-data.
// It also needs a public STT_BASE_URL and an AGENT_SECRET in the shell that differs from the
// local .env.local one. --dry-run prints the target, the module env key names and the exact
// command, and runs nothing. See docs/DEPLOY.md.
import { spawnSync } from 'node:child_process';
import { spacetimeCommand } from './spacetime.mjs';
import { loadEnv, ROOT } from './env.mjs';
import { assertTargetAllowed, describeTarget, resolveTarget, shellQuote } from './target.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const clear = argv.includes('--clear');

const fileEnv = loadEnv();
// Shell variables override .env (e.g. STT_BASE_URL=https://host/stt-proxy.php node scripts/publish.mjs).
const PASS = /^(CARTESIA_|OPENROUTER_|ANTHROPIC_|STT_|TTS_|MEMORY_|SIM_|DASHBOARD_|LESSON_|INSIGHTS_|RETENTION_|AGENT_SECRET$|SPACETIME_DB$|SPACETIME_SERVER$)/;
const env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS.test(k))) };
const target = resolveTarget(env);

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

console.log(`publish ${describeTarget(target)}${clear ? '  (--clear: deletes all data)' : ''}${dryRun ? '  (dry run)' : ''}`);
try {
  assertTargetAllowed(target, argv, { action: 'publish', deletesData: clear, dryRun });
} catch (e) {
  fail(e.message);
}

// Cartesia is always needed; the LLM keys: Anthropic (default) or the OpenRouter pair.
const required = ['CARTESIA_API_KEY', ...(env.ANTHROPIC_API_KEY ? [] : ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'])];
for (const k of required) if (!env[k]) fail(`missing ${k} in .env (set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY + OPENROUTER_MODEL)`);

if (!target.local) {
  if (!env.STT_BASE_URL || /^https?:\/\/(127\.|localhost|\[::1\])/.test(env.STT_BASE_URL)) {
    fail('set STT_BASE_URL to a public URL (the PHP proxy, or https://api.cartesia.ai with CARTESIA_STT_MODEL=ink-whisper): the cloud cannot reach localhost');
  }
  // The laptop's secret must not unlock the shared cloud database (docs/CLOUD_PLAN.md A3).
  if (!process.env.AGENT_SECRET) fail('set a fresh AGENT_SECRET in the shell for a remote server, e.g. export AGENT_SECRET=$(openssl rand -hex 24) (keep it for the worker)');
  if (process.env.AGENT_SECRET === fileEnv.AGENT_SECRET) fail('AGENT_SECRET equals the local .env.local value; use a separate secret for the remote database');
}

const moduleEnv = {
  CARTESIA_API_KEY: env.CARTESIA_API_KEY,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || '',
  OPENROUTER_EXTRACTION_MODEL: env.OPENROUTER_EXTRACTION_MODEL || env.OPENROUTER_MODEL || '',
  AGENT_SECRET: env.AGENT_SECRET,
};
const OPTIONAL_MODULE_ENV = ['STT_BASE_URL', 'CARTESIA_STT_MODEL', 'CARTESIA_TTS_MODEL', 'CARTESIA_VOICE_ID', 'TTS_SAMPLE_RATE', 'MEMORY_EVERY_N_TURNS', 'SIM_MAX_TURNS', 'DASHBOARD_INTERVAL_S', 'DASHBOARD_EFFORT', 'LESSON_ARC', 'INSIGHTS_KEY', 'RETENTION_IMAGE_MIN', 'RETENTION_DAYS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_EXTRACTION_MODEL', 'MEMORY_PROVIDER'];
for (const k of OPTIONAL_MODULE_ENV) if (env[k]) moduleEnv[k] = env[k];

const args = ['publish', target.db, '--server', target.server, '--module-path', 'spacetimedb', '--yes'];
if (clear) args.push('--delete-data=always');
const { command, prefix } = spacetimeCommand();

console.log(`module env: ${Object.keys(moduleEnv).filter(k => moduleEnv[k]).join(', ')}`);
if (!target.local && !env.INSIGHTS_KEY) console.warn('warning: INSIGHTS_KEY is not set; for a shared deployment set it (docs/ARCHITECTURE.md §8)');
if (dryRun) {
  console.log(`[dry-run] (cd ${shellQuote(ROOT)} && ${[command, ...prefix, ...args].map(shellQuote).join(' ')})`);
  process.exit(0);
}
const r = spawnSync(command, [...prefix, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...moduleEnv, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
});
process.exit(r.status ?? 1);
