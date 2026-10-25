// Repo paths and .env loading (same format as scripts/env.mjs). In a git worktree the repo root
// may lack .env; then the nearest ancestor that has one is used (like the worker does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(E2E_DIR, '..');
export const FIXTURES = path.join(E2E_DIR, 'fixtures');
export const OUT_DIR = path.join(E2E_DIR, 'out');
export const SPACETIME = process.env.SPACETIME_BIN || path.join(os.homedir(), '.local/bin/spacetime');
export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function findEnvDir(start = ROOT): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.env'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

/** Keys from the nearest .env (+ .env.local), process env wins. */
export function loadKeys(): Record<string, string> {
  const dir = findEnvDir();
  const merged: Record<string, string> = { ...parseEnvFile(path.join(dir, '.env')), ...parseEnvFile(path.join(dir, '.env.local')) };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^(CARTESIA_|OPENROUTER_)/.test(k)) merged[k] = v;
  return merged;
}
