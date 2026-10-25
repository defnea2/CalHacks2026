// Screenshots of the turn-photo flow (camera button, modal with the fake camera, pending chip).
// `CLIENT_URL=http://127.0.0.1:5191 SPACETIME_DB=night-photo npx tsx spikes/photo-screenshots.ts <outDir>`
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { CHROME } from '../lib/env';

const base = process.env.CLIENT_URL ?? 'http://127.0.0.1:5191';
const db = process.env.SPACETIME_DB ?? '';
if (!db || ['voice-tutor', 'tutor'].includes(db)) throw new Error('set SPACETIME_DB to your own database');
const out = process.argv[2] ?? '.';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(path.join(os.tmpdir(), 'photo-shot-')),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 860 },
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument('globalThis.__name = (f) => f;');
  page.on('pageerror', e => console.log('pageerror', String(e)));
  await page.goto(`${base}/?db=${db}&student=`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="create-user-form"], [data-testid="learner-list"]', { timeout: 15000 });
  const mia = '[data-testid="learner-item"][data-learner-name="Mia"]';
  if (!(await page.$(mia))) {
    await page.type('[data-testid="create-name"]', 'Mia');
    await page.click('[data-testid="create-submit"]');
    await page.waitForSelector(mia, { timeout: 10000 });
  }
  await page.click(mia);
  await page.waitForSelector('[data-testid="mode-self"]', { timeout: 15000 });
  await page.click('[data-testid="mode-self"]');
  await page.waitForSelector('[data-testid="task-text"]');
  await page.type('[data-testid="task-text"]', 'My homework');
  if (await page.$('[data-testid="text-mode"]')) await page.click('[data-testid="text-mode"]');
  await page.click('[data-testid="start-session"]');
  await page.waitForSelector('[data-testid="photo-button"]', { timeout: 20000 });
  await sleep(1500);
  await page.screenshot({ path: path.join(out, '28a-photo-button.png') });
  await page.click('[data-testid="photo-button"]');
  await page.waitForSelector('[data-testid="photo-video"]', { timeout: 10000 });
  await page.waitForFunction(() => (document.querySelector('[data-testid="photo-video"]') as HTMLVideoElement)?.videoWidth > 0, { timeout: 10000 });
  await sleep(800);
  await page.screenshot({ path: path.join(out, '28b-camera-modal.png') });
  await page.click('[data-testid="photo-capture"]');
  await page.waitForSelector('[data-testid="photo-review"]', { timeout: 10000 });
  await page.screenshot({ path: path.join(out, '28c-photo-review.png') });
  await page.click('[data-testid="photo-use"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="turn-photo"]')?.getAttribute('data-state') === 'pending', { timeout: 10000 });
  await sleep(500);
  await page.screenshot({ path: path.join(out, '28d-photo-pending.png') });
  const chip = await page.$('[data-testid="turn-photo"]');
  console.log('chip:', await chip?.evaluate(e => e.textContent));
  await page.type('[data-testid="text-input"]', 'Can you help me with this?');
  await page.click('[data-testid="text-send"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="turn-photo"]')?.getAttribute('data-state') === 'sent', { timeout: 10000 });
  await page.screenshot({ path: path.join(out, '28e-photo-sent.png') });
  console.log('chip:', await chip?.evaluate(e => e.textContent));
} finally {
  await browser.close();
}
