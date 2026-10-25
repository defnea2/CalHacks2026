// Latency run: one fixture -> headless Chrome with a fake microphone -> one session on the
// tutor-lat database. Collects window.__tutor.events, per-frame VAD stats (window.__lat),
// row-arrival and DOM-render hooks, and every websocket frame (CDP Network domain), then writes
// <out>/<label>.client.json. Server (`spacetime logs`) and worker/fake-LLM logs are joined later
// by analyze.mjs.
//
// Usage: node e2e/latency/run.mjs <wav> <label> [seconds=25] [extraQuery]
// Env: BASE (http://127.0.0.1:5190), DB (tutor-lat), OUT (/tmp/lat/runs), OBSERVER=1 opens an
// observer page in a second browser and records its row arrivals too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', 'package.json'));
const puppeteer = require('puppeteer-core');

const [wavArg, label = 'run', secsArg = '25', extraQuery = ''] = process.argv.slice(2);
if (!wavArg) {
  console.error('usage: node e2e/latency/run.mjs <wav> <label> [seconds] [extraQuery]');
  process.exit(2);
}
const BASE = process.env.BASE ?? 'http://127.0.0.1:5190';
const DB = process.env.DB ?? 'tutor-lat';
const OUT = process.env.OUT ?? '/tmp/lat/runs';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tid = (id, extra = '') => `[data-testid="${id}"]${extra}`;

async function launch(wav) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-lat-'));
  const args = [
    '--no-first-run',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceSandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (wav) {
    const copy = path.join(profile, 'mic.wav'); // macOS TCC: Chrome cannot read ~/Desktop
    fs.copyFileSync(wav, copy);
    args.push(`--use-file-for-fake-audio-capture=${copy}`);
  }
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 60_000, userDataDir: path.join(profile, 'p'), args });
  return { browser, close: async () => { await browser.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); } };
}

/** Records every websocket frame with CDP timestamps (seconds, monotonic) + wall time. */
async function wsCapture(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const frames = [];
  const rec = dir => p => {
    const d = p.response;
    // opcode 2 = binary (payloadData is base64), 1 = text
    const bytes = d.opcode === 2 ? Buffer.from(d.payloadData, 'base64') : Buffer.from(d.payloadData);
    frames.push({ dir, wall: Date.now(), ts: p.timestamp, opcode: d.opcode, len: bytes.length, b0: bytes[0], b1: bytes[1] });
  };
  cdp.on('Network.webSocketFrameSent', rec('up'));
  cdp.on('Network.webSocketFrameReceived', rec('down'));
  return frames;
}

/** In-page hooks: row arrival times on the session's own connection and DOM render times. */
const HOOKS = () => {
  const L = (window.__latHooks = { rows: [], dom: [] });
  const conn = window.__tutor?.voice?.o?.conn;
  if (!conn) return 'no conn';
  const now = () => ({ t: performance.now(), wall: Date.now() });
  const db = conn.db;
  db.replySentence.onInsert((_c, r) => L.rows.push({ kind: 'sentence.insert', u: String(r.utteranceId), idx: r.idx, status: r.status, ...now() }));
  db.replySentence.onUpdate((_c, _o, r) => L.rows.push({ kind: 'sentence.update', u: String(r.utteranceId), idx: r.idx, status: r.status, ...now() }));
  db.boardItem.onInsert((_c, r) => L.rows.push({ kind: 'board.insert', id: String(r.id), visible: r.visible, ...now() }));
  db.turn.onInsert((_c, r) => L.rows.push({ kind: 'turn.insert', idx: r.idx, role: r.role, status: r.status, ...now() }));
  db.turn.onUpdate((_c, _o, r) => L.rows.push({ kind: 'turn.update', idx: r.idx, role: r.role, status: r.status, ...now() }));
  db.phrase.onInsert((_c, r) => L.rows.push({ kind: 'phrase.insert', p: r.phraseId, status: r.status, ...now() }));
  db.phrase.onUpdate((_c, _o, r) => L.rows.push({ kind: 'phrase.update', p: r.phraseId, status: r.status, ...now() }));
  db.session.onUpdate((_c, _o, r) => L.rows.push({ kind: 'session.update', turnState: r.turnState, phase: r.phase, ...now() }));
  db.audioOut.onInsert((_c, r) => L.rows.push({ kind: 'audio.insert', u: String(r.utteranceId), idx: r.idx, bytes: r.pcm.length, ...now() }));
  db.turnMetrics.onUpdate((_c, _o, r) => L.rows.push({ kind: 'metrics.update', ...now() }));
  const seen = new Set();
  const scan = () => {
    for (const el of document.querySelectorAll('[data-testid="caption-sentence"]')) {
      const k = `cap:${el.closest('[data-testid="caption-tutor"]')?.getAttribute('data-ref')}:${el.getAttribute('data-id')}:${el.getAttribute('data-status')}`;
      if (!seen.has(k)) { seen.add(k); L.dom.push({ kind: 'caption', key: k, ...now() }); }
    }
    for (const el of document.querySelectorAll('[data-testid="caption-phrase"]')) {
      const k = `phr:${el.getAttribute('data-id')}:${el.getAttribute('data-status')}`;
      if (!seen.has(k)) { seen.add(k); L.dom.push({ kind: 'phrase', key: k, ...now() }); }
    }
    for (const el of document.querySelectorAll('[data-testid="board-item"]')) {
      const k = `board:${el.getAttribute('data-id')}:${el.getAttribute('data-revealed')}`;
      if (!seen.has(k)) { seen.add(k); L.dom.push({ kind: 'board', key: k, ...now() }); }
    }
    const ts = document.querySelector('[data-testid="turnstate-indicator"]')?.getAttribute('data-state');
    const k = `ts:${ts}`;
    if (ts && L.lastTs !== k) { L.lastTs = k; L.dom.push({ kind: 'turnstate', key: k, ...now() }); }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true });
  return 'ok';
};

async function observerPage(sessionId) {
  const b = await launch(null);
  const page = await b.browser.newPage();
  await page.evaluateOnNewDocument('globalThis.__name = (f) => f;');
  await page.goto(`${BASE}/?db=${DB}&observe=${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(tid('observer-screen'), { timeout: 20_000 });
  // The observer has no VoiceSession; record DOM renders only (fan-out to a second client).
  await page.evaluate(() => {
    const L = (window.__latHooks = { dom: [] });
    const seen = new Set();
    const scan = () => {
      for (const el of document.querySelectorAll('[data-testid="caption-sentence"]')) {
        const k = `cap:${el.closest('[data-testid="caption-tutor"]')?.getAttribute('data-ref')}:${el.getAttribute('data-id')}:${el.getAttribute('data-status')}`;
        if (!seen.has(k)) { seen.add(k); L.dom.push({ kind: 'caption', key: k, t: performance.now(), wall: Date.now() }); }
      }
      for (const el of document.querySelectorAll('[data-testid="board-item"]')) {
        const k = `board:${el.getAttribute('data-id')}:${el.getAttribute('data-revealed')}`;
        if (!seen.has(k)) { seen.add(k); L.dom.push({ kind: 'board', key: k, t: performance.now(), wall: Date.now() }); }
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const frames = await wsCapture(page);
  return { b, page, frames };
}

const main = async () => {
  const wav = path.resolve(wavArg);
  const b = await launch(wav);
  const page = await b.browser.newPage();
  await page.evaluateOnNewDocument('globalThis.__name = (f) => f;');
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  const q = `db=${DB}${extraQuery ? `&${extraQuery}` : ''}`;
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(tid('conn-status', '[data-status="connected"]'), { timeout: 20_000 });
  const name = `Lat${label.replace(/\W/g, '')}${Date.now() % 100000}`;
  const fill = async (sel, text) => {
    await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
    await page.click(sel, { count: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, text);
  };
  await page.click(tid('role-student'));
  await fill(tid('create-name'), name);
  await fill(tid('create-age'), '9');
  await fill(tid('create-grade'), '4');
  await page.click(tid('create-submit'));
  await page.waitForSelector(tid('learner-item', `[data-learner-name="${name}"]`), { timeout: 15_000 });
  await page.click(tid('learner-item', `[data-learner-name="${name}"]`));
  await page.waitForSelector(tid('mode-self'), { timeout: 10_000 });
  await page.click(tid('mode-self'));
  await page.waitForSelector(tid('start-form'), { timeout: 10_000 });
  await fill(tid('task-text'), 'Expand 2/3 so the denominator is 12.');
  await page.click(tid('start-session'));
  await page.waitForSelector(tid('session-screen'), { timeout: 20_000 });
  const sessionId = await page.$eval(tid('session-screen'), el => el.getAttribute('data-session-id'));
  // session tab URL now carries ?session=; wait until ready
  for (let i = 0; i < 75; i++) {
    const ok = await page.evaluate(() => window.__tutor?.state?.sessionReady === true);
    if (ok) break;
    await sleep(200);
  }
  const obs = process.env.OBSERVER === '1' ? await observerPage(sessionId) : null;
  const frames = await wsCapture(page);
  // Voice auto-starts with the session (no "Start talking" click any more).
  const startWall = Date.now();
  await page.waitForSelector(tid('mic-state'), { timeout: 15_000 });
  const hook = await page.evaluate(HOOKS);
  console.error(`[lat] session ${sessionId} started, hooks: ${hook}`);
  await sleep(Number(secsArg) * 1000);
  const data = await page.evaluate(() => ({
    events: window.__tutor.events,
    frames: window.__lat?.frames ?? [],
    hooks: window.__latHooks ?? null,
    config: window.__tutor.config,
    perfOrigin: performance.timeOrigin,
  }));
  let observer = null;
  if (obs) {
    observer = { dom: await obs.page.evaluate(() => window.__latHooks?.dom ?? []), frames: obs.frames };
    await Promise.race([obs.b.close(), sleep(3000)]);
  }
  const out = { label, wav: path.basename(wav), sessionId, startWall, ...data, wsFrames: frames, observer };
  const file = path.join(OUT, `${label}.client.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.error(`[lat] wrote ${file}: ${data.events.length} events, ${data.frames.length} frames, ${frames.length} ws frames`);
  await Promise.race([b.close(), sleep(3000)]);
  process.exit(0);
};
setTimeout(() => {
  console.error('[lat] hard timeout');
  process.exit(1);
}, (Number(secsArg) + 90) * 1000).unref();
main().catch(e => {
  console.error(e);
  process.exit(1);
});
