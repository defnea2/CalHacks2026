// Loads the root .env and the generated .env.local (AGENT_SECRET). No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Returns merged env; creates .env.local with a random AGENT_SECRET on first use. */
export function loadEnv() {
  const localFile = path.join(ROOT, '.env.local');
  let local = parse(localFile);
  if (!local.AGENT_SECRET) {
    local = { ...local, AGENT_SECRET: crypto.randomBytes(24).toString('hex') };
    fs.appendFileSync(localFile, `AGENT_SECRET=${local.AGENT_SECRET}\n`);
  }
  return { ...parse(path.join(ROOT, '.env')), ...local };
}
