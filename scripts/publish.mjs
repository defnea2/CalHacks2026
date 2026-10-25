// Publishes the module to the local server, passing secrets as SpacetimeDB module env
// (shell variables override spacetime.json). Usage: node scripts/publish.mjs [--clear]
import { spawnSync } from 'node:child_process';
import { loadEnv, ROOT } from './env.mjs';

const env = loadEnv();
const required = ['CARTESIA_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'];
for (const k of required) if (!env[k]) { console.error(`missing ${k} in .env`); process.exit(1); }

const moduleEnv = {
  CARTESIA_API_KEY: env.CARTESIA_API_KEY,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  OPENROUTER_EXTRACTION_MODEL: env.OPENROUTER_EXTRACTION_MODEL || env.OPENROUTER_MODEL,
  AGENT_SECRET: env.AGENT_SECRET,
};
for (const k of ['STT_BASE_URL', 'CARTESIA_STT_MODEL', 'CARTESIA_TTS_MODEL', 'CARTESIA_VOICE_ID', 'TTS_SAMPLE_RATE', 'MEMORY_EVERY_N_TURNS']) if (env[k]) moduleEnv[k] = env[k];

const db = env.SPACETIME_DB || 'tutor';
const args = ['publish', db, '--server', 'local', '--module-path', 'spacetimedb', '--yes'];
if (process.argv.includes('--clear')) args.push('--delete-data=always');
const spacetime = process.env.SPACETIME_BIN || 'spacetime';
const r = spawnSync(spacetime, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...moduleEnv, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
});
process.exit(r.status ?? 1);
