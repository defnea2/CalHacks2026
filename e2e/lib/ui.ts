// UI flow: create test user -> pick learner -> task text -> start session -> start talking.
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
  await fill(page, tid('create-name'), learnerName);
  await fill(page, tid('create-age'), '9');
  await fill(page, tid('create-grade'), '4');
  await page.click(tid('create-submit'));
  const item = tid('learner-item', `[data-learner-name="${learnerName}"]`);
  await page.waitForSelector(item, { timeout: 15_000 });
  await page.click(item);
  await page.waitForSelector(tid('start-form'), { timeout: 10_000 });
  await fill(page, tid('task-text'), taskText);
  await page.click(tid('start-session'));
  await page.waitForSelector(tid('session-screen'), { timeout: 20_000 });
  const id = await page.$eval(tid('session-screen'), el => el.getAttribute('data-session-id'));
  if (!id) throw new Error('session-screen without data-session-id');
  await until(page, 'session ready', 15_000, () => window.__tutor?.state?.sessionReady === true && !!document.querySelector('[data-testid="start-talking"]:not([disabled])'));
  return id;
}

export async function startTalking(page: Page): Promise<number> {
  await page.evaluate(() => window.__tutor.clear());
  const at = Date.now();
  await page.click(tid('start-talking'));
  await page.waitForSelector(tid('mic-state'), { timeout: 15_000 });
  return at;
}
