// Headless smoke test over the Chrome DevTools Protocol (no extra deps; Node 22+ WebSocket).
// Usage: node scripts/smoke-cdp.mjs <url> <wav> [seconds] [js-to-run-after-load]
// Starts headless Chrome with a fake microphone playing <wav>, opens <url>, optionally runs a
// JS snippet (e.g. a click), waits, then prints window.__tutor.events as JSON lines.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [url, wav, secs = '12', jsArg = ''] = process.argv.slice(2);
const js = jsArg.startsWith('@') ? (await import('node:fs')).readFileSync(jsArg.slice(1), 'utf8') : jsArg;
if (!url || !wav) {
  console.error('usage: node scripts/smoke-cdp.mjs <url> <wav> [seconds] [js]');
  process.exit(2);
}
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'tutor-smoke-'));
// macOS privacy protection (TCC) keeps Chrome from reading files under ~/Desktop etc.: the fake
// microphone then silently delivers zeros. Copy the wav next to the temp profile first.
const fakeWav = join(profile, 'mic.wav');
if (wav !== '-') copyFileSync(resolve(wav), fakeWav);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(wav === '-' ? [] : [`--use-file-for-fake-audio-capture=${fakeWav}`]),
    '--autoplay-policy=no-user-gesture-required',
    // Without this the sandboxed audio service cannot read the wav and the fake mic is silent.
    '--disable-features=AudioServiceSandbox',
    ...(process.env.CHROME_EXTRA ? process.env.CHROME_EXTRA.split(' ') : []),
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      break;
    }
  } catch {}
  await sleep(200);
}
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    console.error('[console]', m.params.type, m.params.args.map(a => a.value ?? a.description).join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.error('[exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) =>
  new Promise(r => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(3000);
if (js) console.error('[js]', JSON.stringify(await evaluate(js)));
await sleep(Number(secs) * 1000);
if (process.env.SHOT) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
}
const res = await evaluate('JSON.stringify(window.__tutor ? window.__tutor.events : null)');
const events = JSON.parse(res.result?.value ?? 'null') ?? [];
for (const e of events) console.log(JSON.stringify(e));
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
