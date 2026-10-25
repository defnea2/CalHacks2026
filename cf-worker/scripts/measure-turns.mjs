// Latency of typed turns through whatever answers on a database (Cloudflare dispatch or the Node
// worker): creates a text-mode session, sends the turns one after another and prints, from the
// server's own timestamps (turn_metrics, beat), turn end -> first sentence and the gaps between beats.
//
//   STDB=https://maincloud.spacetimedb.com DB=fibonacci-cfdev node cf-worker/scripts/measure-turns.mjs [n]
// Writes a test learner + session into the target database.
const STDB = process.env.STDB ?? 'http://127.0.0.1:3000';
const DB = process.env.DB ?? 'cfdispatch-dev';
const N = Number(process.argv[2] ?? 4);
const TURNS = ['I think it is 3/3, is that right?', 'Why is that one whole?', 'Can you show me another way?', 'So 2/4 plus 2/4 is one too?', 'What about 1/2 plus 1/3?', 'I am not sure.'];

async function call(token, name, args) {
  const r = await fetch(`${STDB}/v1/database/${DB}/call/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
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
const ms = t => (t == null ? null : Number(Array.isArray(t) ? t[0] : (t.__timestamp_micros_since_unix_epoch__ ?? t)) / 1000);
// SATS JSON: option = [0, value] (some) | [1, []] (none); timestamp = [micros].
const opt = v => (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) ? (v[0] === 0 ? v[1] : null) : v);

const token = (await (await fetch(`${STDB}/v1/identity`, { method: 'POST' })).json()).token;
const name = `Measure ${Date.now() % 100000}`;
await call(token, 'create_test_user', [name, 9, 4, 'visual']);
const learner = (await sql(token, 'SELECT * FROM learner')).find(l => l.name === name);
await call(token, 'start_session', [learner.id, 'What is 2/3 + 1/3?']);
const sessionId = (await sql(token, `SELECT * FROM session WHERE learner_id = ${learner.id}`)).at(-1).id;
await call(token, 'set_session_voice', [sessionId, false]);
console.log(`db ${DB} session ${sessionId}`);

const rows = [];
for (let i = 0; i < N; i++) {
  const text = TURNS[i % TURNS.length];
  const t0 = Date.now();
  await call(token, 'submit_text_turn', [sessionId, text, '']);
  let tutor;
  for (let k = 0; k < 400 && !tutor; k++) {
    await sleep(150);
    tutor = (await sql(token, `SELECT * FROM turn WHERE session_id = ${sessionId}`)).filter(t => t.role === 'tutor').find(t => (rows.at(-1)?.u ?? -1) !== t.utterance_id && !rows.some(r => r.u === t.utterance_id));
  }
  // Wait until the text-mode reading is over (the next turn would interrupt it).
  for (let k = 0; k < 200; k++) {
    const s = (await sql(token, `SELECT * FROM session WHERE id = ${sessionId}`))[0];
    if (s.turn_state === 'listening') break;
    await sleep(250);
  }
  const u = tutor?.utterance_id;
  const m = (await sql(token, `SELECT * FROM turn_metrics WHERE session_id = ${sessionId}`)).find(x => x.utterance_id === u);
  const beats = (await sql(token, `SELECT * FROM beat WHERE session_id = ${sessionId}`)).filter(b => b.utterance_id === u).map(b => ms(b.created_at)).sort((a, b) => a - b);
  const end = ms(opt(m?.turn_end_at));
  const first = ms(opt(m?.first_sentence_at));
  const row = { u, text, beats: beats.length, firstSentence: first && end ? Math.round(first - end) : null, firstBeat: beats.length && end ? Math.round(beats[0] - end) : null, gaps: beats.slice(1).map((b, j) => Math.round(b - beats[j])), wall: Date.now() - t0, tutor: tutor ? String(tutor.text).slice(0, 60) : 'MISSING' };
  rows.push(row);
  console.log(`turn ${i}: first sentence ${row.firstSentence} ms, first beat ${row.firstBeat} ms, ${row.beats} beats, gaps ${JSON.stringify(row.gaps)} ms, "${row.tutor}"`);
}
const fs = rows.map(r => r.firstSentence).filter(x => x != null).sort((a, b) => a - b);
const gaps = rows.flatMap(r => r.gaps).sort((a, b) => a - b);
const p = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null);
console.log(`turn end -> first sentence: p50 ${p(fs, 0.5)} ms, max ${fs.at(-1)} ms (n=${fs.length}); beat gaps p50 ${p(gaps, 0.5)} ms, p90 ${p(gaps, 0.9)} ms`);
