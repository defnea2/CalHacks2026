// UI flow: entry (role student) -> create test user -> pick learner -> "Learn by myself" -> task text -> start session.
// Voice only: "Start my lesson" opens the session screen with microphone + sound already on (no
// separate "Start talking" step), so the harness just waits for the microphone.
import type { Page } from 'puppeteer-core';
import { fill, tid, until } from './browser';

declare global {
  interface Window {
    __tutor: {
      events: Array<{ t: number; wall: number; type: string; [k: string]: unknown }>;
      state: Record<string, unknown>;
      clear(): void;
    };
  }
}

export async function waitConnected(page: Page): Promise<void> {
  await page.waitForSelector(tid('conn-status', '[data-status="connected"]'), { timeout: 20_000 });
}

/** Returns the new session id. */
export async function createSessionViaUi(page: Page, baseUrl: string, learnerName: string, taskText: string): Promise<string> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitConnected(page);
  await page.click(tid('role-student'));
  await fill(page, tid('create-name'), learnerName);
  await fill(page, tid('create-age'), '9');
  await fill(page, tid('create-grade'), '4');
  await page.click(tid('create-submit'));
  const item = tid('learner-item', `[data-learner-name="${learnerName}"]`);
  await page.waitForSelector(item, { timeout: 15_000 });
  await page.click(item);
  await page.waitForSelector(tid('mode-self'), { timeout: 10_000 });
  await page.click(tid('mode-self'));
  await page.waitForSelector(tid('start-form'), { timeout: 10_000 });
  await fill(page, tid('task-text'), taskText);
  await page.click(tid('start-session'));
  await page.waitForSelector(tid('session-screen'), { timeout: 20_000 });
  const id = await page.$eval(tid('session-screen'), el => el.getAttribute('data-session-id'));
  if (!id) throw new Error('session-screen without data-session-id');
  await until(page, 'session ready', 15_000, () => window.__tutor?.state?.sessionReady === true);
  return id;
}

/** The session auto-starts microphone + playback; wait until the microphone is on (or fails). */
export async function startTalking(page: Page): Promise<number> {
  await page.waitForSelector(`${tid('mic-state')}, ${tid('mic-error')}`, { timeout: 20_000 });
  const err = await page.$(tid('mic-error'));
  if (err) throw new Error(`microphone did not start: ${await page.$eval(tid('mic-error'), el => el.textContent)}`);
  return Date.now();
}
