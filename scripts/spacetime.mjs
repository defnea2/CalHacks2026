// Resolve the optional project-local CLI without modifying the user's shell configuration.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT } from './env.mjs';

export function spacetimeCommand(env = process.env) {
  if (env.SPACETIME_BIN) return { command: env.SPACETIME_BIN, prefix: [] };
  const local = join(ROOT, '.tools', 'spacetime', 'spacetime');
  return existsSync(local) ? { command: local, prefix: [`--root-dir=${dirname(local)}`] } : { command: 'spacetime', prefix: [] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, prefix } = spacetimeCommand();
  const result = spawnSync(command, [...prefix, ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) console.error(`Could not start SpacetimeDB: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
