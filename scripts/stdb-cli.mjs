// Small helpers around the spacetime CLI for the operator scripts (seed-demo.mjs, simulate.mjs).
// Always --server local and --no-config from a neutral cwd (never picks up spacetime.json, never
// Maincloud). SPACETIME_DB selects the database (default voice-tutor).
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { spacetimeCommand } from './spacetime.mjs';
import { loadEnv } from './env.mjs';

export const db = process.env.SPACETIME_DB || 'voice-tutor';

const env = {
  ...process.env,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  PATH: `${os.homedir()}/.local/bin:${process.env.PATH}`,
};
const { command, prefix } = spacetimeCommand(env);

/** Runs the CLI; `secret` values are masked in error messages. */
export function cli(args, { secret } = {}) {
  const r = spawnSync(command, [...prefix, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  const mask = s => (secret ? s.split(secret).join('<secret>') : s);
  if (r.error) throw new Error(`could not run spacetime: ${r.error.message}`);
  if (r.status !== 0) {
    const out = `${r.stderr}\n${r.stdout}`.split('\n').filter(l => l.trim() && !/^WARNING: This command is UNSTABLE/.test(l)).join('\n');
    throw new Error(`spacetime ${args[0]} failed: ${mask(out.trim())}`);
  }
  return r.stdout;
}

/** Parses the `spacetime sql` table output into objects (string cells are JSON-quoted). */
export function sql(query) {
  const lines = cli(['sql', '--no-config', '--server', 'local', db, query])
    .split('\n')
    .filter(l => l.includes('|') || /^-+\+/.test(l));
  const sep = lines.findIndex(l => /^-+\+/.test(l));
  if (sep < 1) return [];
  const header = lines[sep - 1].split('|').map(s => s.trim());
  return lines.slice(sep + 1).map(line => {
    const cells = line.split('|').map(s => s.trim());
    const row = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? '';
      try {
        row[h] = v.startsWith('"') ? JSON.parse(v) : v;
      } catch {
        row[h] = v;
      }
    });
    return row;
  });
}

/** Calls a reducer; args are passed as JSON values (strings JSON-quoted, numbers as text). */
export function call(reducer, args, opts) {
  return cli(['call', '--no-config', '--server', 'local', db, reducer, ...args], opts);
}

/** Registers the CLI identity as agent with AGENT_SECRET from .env.local (never printed). */
export function registerAgent() {
  const secret = loadEnv().AGENT_SECRET;
  if (!secret) throw new Error('AGENT_SECRET missing in .env.local');
  call('register_agent', [JSON.stringify(secret)], { secret });
}
