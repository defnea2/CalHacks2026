// Smoke test of a deployed (or locally served) static client build, in headless Chrome with a fake
// microphone: the entry page connects, a test learner is created, a voice session starts, the
// fixture speech is transcribed and the tutor answers. Prints the same-origin asset responses
// (VAD / ONNX / wasm content types). It writes a test learner + session into the target database.
//
// Usage: pnpm --filter e2e smoke:deployed <url> [wav]
//   url  e.g. https://fibonacci.pages.dev/  or  http://127.0.0.1:5391/?db=night-pages
//   wav  default fixtures/correct-step.wav (pnpm --filter e2e gen-speech)
// CHROME=/path/to/chrome overrides the browser. Needs the worker running against that database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const [url, wav = path.join(here, 'fixtures', 'correct-step.wav')] = process.argv.slice(2);
if (!url) {
  console.error('usage: pnpm --filter e2e smoke:deployed <url> [wav]');
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-pages-'));
const mic = path.join(dir, 'mic.wav');
fs.copyFileSync(wav, mic);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: path.join(dir, 'profile'),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--autoplay-policy=no-user-gesture-required', '--disable-features=AudioServiceSandbox'],
});
const page = await browser.newPage();
const reqs = [];
page.on('response', r => { const u = new URL(r.url()); if (u.host === new URL(url).host) reqs.push(`${r.status()} ${u.pathname} ${r.headers()['content-type'] ?? ''}`); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
const tid = id => `[data-testid="${id}"]`;
const fill = async (sel, v) => { await page.click(sel, { count: 3 }); await page.type(sel, v); };
const t0 = Date.now();
const log = m => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`${tid('conn-status')}[data-status="connected"]`, { timeout: 20000 });
  log('entry connected');
  await page.click(tid('role-student'));
  const name = `Smoke ${Date.now() % 100000}`;
  await fill(tid('create-name'), name);
  await fill(tid('create-age'), '9');
  await fill(tid('create-grade'), '4');
  await page.click(tid('create-submit'));
  const item = `${tid('learner-item')}[data-learner-name="${name}"]`;
  await page.waitForSelector(item, { timeout: 15000 });
  await page.click(item);
  await page.waitForSelector(tid('mode-self'), { timeout: 10000 });
  await page.click(tid('mode-self'));
  await page.waitForSelector(tid('start-form'), { timeout: 10000 });
  await fill(tid('task-text'), 'What is 2/3 + 1/3?');
  await page.click(tid('start-session'));
  await page.waitForSelector(tid('session-screen'), { timeout: 20000 });
  log(`session ${await page.$eval(tid('session-screen'), el => el.getAttribute('data-session-id'))}`);
  await page.waitForSelector(`${tid('mic-state')}, ${tid('mic-error')}`, { timeout: 20000 });
  log((await page.$(tid('mic-error'))) ? `MIC ERROR: ${await page.$eval(tid('mic-error'), el => el.textContent)}` : 'mic on');
  const end = Date.now() + 40000;
  let caps = [];
  while (Date.now() < end) {
    caps = await page.$$eval('[data-testid="caption-sentence"]', els => els.map(e => e.textContent.trim()));
    const student = await page.$$eval('[data-testid="caption-phrase"]', els => els.map(e => e.textContent.trim()));
    if (caps.length >= 3 && student.length) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  log(`tutor sentences: ${caps.length}: ${caps.slice(0, 3).join(' | ').slice(0, 300)}`);
  if (!caps.length) process.exitCode = 1;
  log(`student phrases: ${JSON.stringify(await page.$$eval('[data-testid="caption-phrase"]', els => els.map(e => e.textContent.trim())))}`);
  const ev = await page.evaluate(() => (window.__tutor?.events ?? []).filter(e => /capture|vad|smart|playback\.start|error/i.test(e.type)).slice(0, 25).map(e => `${e.type} ${JSON.stringify(e).slice(0, 160)}`));
  console.log(ev.join('\n'));
} catch (e) {
  log(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  console.log('--- same-origin responses');
  console.log([...new Set(reqs)].filter(r => !/\/assets\/.*\.(js|css)/.test(r) || /worker/.test(r)).join('\n'));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
