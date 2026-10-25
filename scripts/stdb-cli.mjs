// Small helpers around the spacetime CLI for the operator scripts (seed-demo.mjs, simulate.mjs).
// Always an explicit --server (SPACETIME_SERVER, default `local`) and --no-config from a neutral
// cwd, so spacetime.json and the CLI's own default server (which may be maincloud) are never
// used. SPACETIME_DB selects the database (default voice-tutor).
//
// A non-local server needs --yes-remote on the command line (checked by assertTarget()).
// --dry-run prints every CLI command (reads too) and runs none; sql() then returns no rows.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { spacetimeCommand } from './spacetime.mjs';
import { loadEnv } from './env.mjs';
import { assertTargetAllowed, describeTarget, resolveTarget, shellQuote } from './target.mjs';

export const target = resolveTarget();
export const db = target.db;
export const server = target.server;
export const dryRun = process.argv.includes('--dry-run');

const env = {
  ...process.env,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  PATH: `${os.homedir()}/.local/bin:${process.env.PATH}`,
};
const { command, prefix } = spacetimeCommand(env);

/** Prints the target and throws when a remote target is not confirmed (--yes-remote). */
export function assertTarget(action) {
  console.log(`${action}: ${describeTarget(target)}${dryRun ? '  (dry run: commands are printed, nothing runs)' : ''}`);
  assertTargetAllowed(target, process.argv.slice(2), { action, dryRun });
}

/** Runs the CLI; `secret` values are masked in error messages (and in dry-run output). */
export function cli(args, { secret } = {}) {
  const mask = s => (secret ? s.split(secret).join('<secret>') : s);
  if (dryRun) {
    console.log(`  [dry-run] ${mask([command, ...prefix, ...args].map(shellQuote).join(' '))}`);
    return '';
  }
  const r = spawnSync(command, [...prefix, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  if (r.error) throw new Error(`could not run spacetime: ${r.error.message}`);
  if (r.status !== 0) {
    const out = `${r.stderr}\n${r.stdout}`.split('\n').filter(l => l.trim() && !/^WARNING: This command is UNSTABLE/.test(l)).join('\n');
    throw new Error(`spacetime ${args[0]} failed: ${mask(out.trim())}`);
  }
  return r.stdout;
}

/** Parses the `spacetime sql` table output into objects (string cells are JSON-quoted). */
export function sql(query) {
  const lines = cli(['sql', '--no-config', '--server', server, db, query])
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
  return cli(['call', '--no-config', '--server', server, db, reducer, ...args], opts);
}

/**
 * Registers the CLI identity as agent. The secret is AGENT_SECRET from the shell, else from
 * .env.local (never printed). On a remote server the shell value is required: it must be the
 * cloud secret the module was published with, not the laptop's.
 */
export function registerAgent() {
  const secret = process.env.AGENT_SECRET || (target.local ? loadEnv().AGENT_SECRET : '') || (dryRun ? '<AGENT_SECRET>' : '');
  if (!secret) throw new Error(target.local ? 'AGENT_SECRET missing in .env.local' : 'set AGENT_SECRET in the shell to the secret the remote database was published with');
  call('register_agent', [JSON.stringify(secret)], { secret });
}
