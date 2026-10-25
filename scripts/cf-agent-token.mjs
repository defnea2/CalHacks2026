// Creates a SpacetimeDB identity for the Cloudflare dispatch Worker and registers it as agent
// (register_agent with AGENT_SECRET), all over the HTTP API. Prints ONLY the token on stdout, so it
// can be piped straight into a Cloudflare secret without showing up anywhere:
//
//   SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-cfdev AGENT_SECRET=... \
//     node scripts/cf-agent-token.mjs --yes-remote | npx wrangler secret put STDB_TOKEN --cwd cf-worker
//
//   SPACETIME_SERVER  local (default, http://127.0.0.1:3000), maincloud, or an http(s) URL
//   SPACETIME_DB      database name (default voice-tutor)
//   AGENT_SECRET      the database's agent secret (shell; for local, .env.local is used)
//
// --out <file> writes the token to a file (mode 600) instead of stdout. The token is a JWT without
// `exp` (checked 2026-10-25 on 2.13): it stays valid until the database's agent secret changes and
// the identity is not re-registered. Never commit it.
import fs from 'node:fs';
import { loadEnv } from './env.mjs';
import { assertTargetAllowed, describeTarget, resolveTarget } from './target.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : '';
const target = resolveTarget(process.env);
const fail = msg => {
  console.error(`cf-agent-token: ${msg}`);
  process.exit(1);
};
console.error(`cf-agent-token ${describeTarget(target)}`);
try {
  assertTargetAllowed(target, argv, { action: 'cf-agent-token' });
} catch (e) {
  fail(e.message);
}

function httpBase(server) {
  if (server === 'local') return 'http://127.0.0.1:3000';
  if (server === 'maincloud') return 'https://maincloud.spacetimedb.com';
  if (/^https?:\/\//.test(server)) return server.replace(/\/+$/, '');
  if (/^wss?:\/\//.test(server)) return server.replace(/^ws/, 'http').replace(/\/+$/, '');
  throw new Error(`unknown SPACETIME_SERVER ${server} (use local, maincloud or a URL)`);
}

const secret = process.env.AGENT_SECRET || (target.local ? loadEnv().AGENT_SECRET : '');
if (!secret) fail('set AGENT_SECRET (the secret the database was published with)');
const base = httpBase(target.server);

const idRes = await fetch(`${base}/v1/identity`, { method: 'POST' });
if (!idRes.ok) fail(`POST /v1/identity: HTTP ${idRes.status}`);
const { identity, token } = await idRes.json();
const reg = await fetch(`${base}/v1/database/${encodeURIComponent(target.db)}/call/register_agent`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify([secret]),
});
if (!reg.ok) fail(`register_agent: HTTP ${reg.status} ${(await reg.text()).slice(0, 200)}`);
console.error(`registered agent identity ${identity.slice(0, 16)}… on ${target.db}`);
if (out) {
  fs.writeFileSync(out, token, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.error(`token written to ${out} (mode 600)`);
} else process.stdout.write(token);
