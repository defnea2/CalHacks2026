// Local end-to-end of the Cloudflare dispatch path without a public URL (SpacetimeDB procedures
// cannot reach loopback): the module runs with LLM_DISPATCH=manual, this script plays the
// module's POST. It creates a text-mode session, submits a turn, takes the module-built dispatch
// body (procedure take_dispatch, as agent), signs it like dispatchTurn and POSTs it to `wrangler dev`,
// which streams Claude and writes the lesson back to the local SpacetimeDB over HTTP.
//
//   SPACETIME_DB=cfdispatch-dev LLM_DISPATCH=manual node scripts/publish.mjs
//   (cd cf-worker && npx wrangler dev --port 8790)        # .dev.vars: STDB_URL/DB/TOKEN, keys
//   node cf-worker/scripts/replay-local.mjs [--duplicate] [--barge-in]
//
// Env: STDB (http://127.0.0.1:3000), DB (cfdispatch-dev), WORKER (http://127.0.0.1:8790), DEV_VARS
// (cf-worker/.dev.vars: STDB_TOKEN = a registered agent token, CF_DISPATCH_SECRET).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STDB = process.env.STDB ?? 'http://127.0.0.1:3000';
const DB = process.env.DB ?? 'cfdispatch-dev';
const WORKER = process.env.WORKER ?? 'http://127.0.0.1:8790';
const vars = Object.fromEntries(
  fs
    .readFileSync(process.env.DEV_VARS ?? path.join(here, '..', '.dev.vars'), 'utf8')
    .split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map(m => [m[1], m[2]])
);
const argv = process.argv.slice(2);

const big = a => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `__u64__${v}__` : v)).replace(/"__u64__(\d+)__"/g, '$1');
async function call(token, name, args) {
  const r = await fetch(`${STDB}/v1/database/${DB}/call/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: big(args) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text;
}
async function sql(token, q) {
  const r = await fetch(`${STDB}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: q });
  const [res] = await r.json();
  const cols = res.schema.elements.map(e => e.name.some);
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(body) {
  const ts = String(Date.now());
  const d = JSON.parse(body);
  const nonce = `${d.dispatchId}:${d.attempt}`;
  const sig = crypto.createHmac('sha256', vars.CF_DISPATCH_SECRET).update(`${ts}.${nonce}.${body}`).digest('hex');
  const t0 = Date.now();
  const r = await fetch(`${WORKER}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dispatch-Ts': ts, 'X-Dispatch-Nonce': nonce, 'X-Dispatch-Signature': sig }, body });
  return { status: r.status, ms: Date.now() - t0, at: t0 };
}

const agent = vars.STDB_TOKEN;
const client = (await (await fetch(`${STDB}/v1/identity`, { method: 'POST' })).json()).token;
const name = `Replay ${Date.now() % 100000}`;
await call(client, 'create_test_user', [name, 9, 4, 'visual']);
const learner = (await sql(client, 'SELECT * FROM learner')).find(l => l.name === name);
await call(client, 'start_session', [learner.id, 'What is 2/3 + 1/3?']);
const sess = (await sql(client, 'SELECT * FROM session')).filter(s => s.learner_id === learner.id).at(-1);
const sessionId = BigInt(sess.id);
await call(client, 'set_session_voice', [sessionId, false]);
console.log(`session ${sessionId}`);

async function turn(text, opts = {}) {
  await call(client, 'submit_text_turn', [sessionId, text, '']);
  const body = JSON.parse(await call(agent, 'take_dispatch', [sessionId]));
  if (!body) throw new Error('no pending dispatch (is the module published with LLM_DISPATCH=manual?)');
  const u = JSON.parse(body).utteranceId;
  const p = await post(body);
  console.log(`turn "${text}": dispatch ${JSON.parse(body).dispatchId} u${u} body ${(body.length / 1024).toFixed(1)} KB -> ${p.status} in ${p.ms} ms`);
  let beats = [];
  let tutor;
  let interrupted = false;
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    beats = (await sql(client, `SELECT * FROM beat WHERE session_id = ${sessionId}`)).filter(b => String(b.utterance_id) === u);
    if (opts.bargeIn && beats.length >= 1 && !interrupted) {
      interrupted = true;
      await call(client, 'interrupt', [sessionId]);
      console.log(`  barge-in after beat ${beats.length - 1} (${Date.now() - p.at} ms)`);
    }
    tutor = (await sql(client, `SELECT * FROM turn WHERE session_id = ${sessionId}`)).find(t => t.role === 'tutor' && String(t.utterance_id) === u);
    if (tutor) break;
  }
  const at = b => Number(b.created_at.__timestamp_micros_since_unix_epoch__ ?? b.created_at[0] ?? 0) / 1000;
  const times = beats.map(at).sort((a, b) => a - b);
  console.log(
    `  ${beats.length} beats; dispatch -> first beat ${times.length ? Math.round(times[0] - p.at) : '-'} ms; beat gaps ${JSON.stringify(times.slice(1).map((t, i) => Math.round(t - times[i])))} ms; ` +
      `tutor turn ${tutor ? `${tutor.interrupted ? 'interrupted' : 'done'} "${String(tutor.text).slice(0, 80)}"` : 'MISSING'}`
  );
  if (opts.duplicate) {
    const again = await post(body);
    await sleep(3000);
    const after = (await sql(client, `SELECT * FROM beat WHERE session_id = ${sessionId}`)).filter(b => String(b.utterance_id) === u).length;
    console.log(`  duplicate delivery -> ${again.status}; beats before ${beats.length}, after ${after} (must be equal)`);
  }
  return { beats: beats.length, tutor };
}

await turn('I think it is 3/3, is that right?', { duplicate: argv.includes('--duplicate') });
if (argv.includes('--barge-in')) await turn('Why is it one whole?', { bargeIn: true });
