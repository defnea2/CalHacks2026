// Screenshots of the voice-only student flow: start form, auto-started session, sound settings
// popover (session + ?miccheck). Fake microphone (fixture wav), headless Chrome.
//   BASE=http://127.0.0.1:5192/ DB=night-voiceux OUT=../docs/screenshots npx tsx spikes/voice-ux-shots.ts
import path from 'node:path';
import { launch, fill, tid } from '../lib/browser';
import { startTalking, waitConnected } from '../lib/ui';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5192/';
const DB = process.env.DB ?? 'night-voiceux';
const OUT = path.resolve(process.env.OUT ?? '../docs/screenshots');
const WAIT_MS = Number(process.env.WAIT_MS ?? 20_000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const mic = await launch(path.resolve('fixtures/correct-step.wav'), 4000);
try {
  const page = await mic.newPage('shots', m => console.log(m));
  await page.setViewport({ width: 1280, height: 800 });
  const url = `${BASE}?db=${DB}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitConnected(page);
  await page.click(tid('role-student'));
  const name = `Mia ${Date.now() % 1000}`;
  await fill(page, tid('create-name'), name);
  await page.click(tid('create-submit'));
  const item = tid('learner-item', `[data-learner-name="${name}"]`);
  await page.waitForSelector(item, { timeout: 15_000 });
  await page.click(item);
  await page.click(tid('mode-self'));
  await page.waitForSelector(tid('start-form'));
  await fill(page, tid('task-text'), 'Expand 2/3 so the bottom number is 12.');
  await page.screenshot({ path: path.join(OUT, '27-start-form-voice-only.png') });
  await page.click(tid('start-session'));
  await page.waitForSelector(tid('session-screen'), { timeout: 20_000 });
  await startTalking(page);
  await sleep(WAIT_MS);
  await page.screenshot({ path: path.join(OUT, '27-session-autostarted.png') });
  await page.click(tid('audio-settings'));
  await page.waitForSelector(tid('audio-settings-panel'));
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '27-session-sound-settings.png') });
  console.log('options', await page.$$eval(`${tid('mic-select')} option`, o => o.map(x => x.textContent)), 'speaker select', !!(await page.$(tid('speaker-select'))));

  const mc = await mic.newPage('miccheck', m => console.log(m));
  await mc.setViewport({ width: 1280, height: 800 });
  await mc.goto(`${BASE}?db=${DB}&miccheck`, { waitUntil: 'domcontentloaded' });
  await mc.click(tid('miccheck-start'));
  await mc.waitForSelector(tid('miccheck-meter', '[data-running="true"]'), { timeout: 20_000 });
  await mc.click(tid('audio-settings'));
  await sleep(1500);
  await mc.screenshot({ path: path.join(OUT, '27-miccheck-sound-settings.png') });
} finally {
  await mic.close();
}
