// Headless Chrome with a fake microphone (one browser per fixture: the fake mic is per process).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { CHROME } from './env';

export interface MicBrowser {
  browser: Browser;
  profile: string;
  close(): Promise<void>;
  newPage(label: string, onLog: (m: string) => void): Promise<Page>;
}

export async function launch(wav: string | null): Promise<MicBrowser> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-e2e-'));
  // macOS TCC keeps Chrome from reading files under ~/Desktop: the fake mic then delivers zeros.
  const args = [
    '--no-first-run',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Otherwise the sandboxed audio service cannot read the wav and the fake mic is silent.
    '--disable-features=AudioServiceSandbox',
    // Several headless browsers in parallel: keep background tabs/timers at full speed.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (wav) {
    const copy = path.join(profile, 'mic.wav');
    fs.copyFileSync(wav, copy);
    args.push(`--use-file-for-fake-audio-capture=${copy}`);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: path.join(profile, 'profile'),
    args,
    defaultViewport: { width: 1280, height: 1400 },
  });
  return {
    browser,
    profile,
    async newPage(label, onLog) {
      const page = await browser.newPage();
      // tsx (esbuild keepNames) wraps named functions in __name(); functions passed to
      // page.evaluate run in the page, where that helper does not exist.
      await page.evaluateOnNewDocument('globalThis.__name = (f) => f;');
      page.on('pageerror', e => onLog(`[${label} pageerror] ${e instanceof Error ? e.message : String(e)}`));
      page.on('console', m => {
        if (m.type() === 'error' || m.type() === 'warn') onLog(`[${label} console.${m.type()}] ${m.text()}`);
      });
      return page;
    },
    async close() {
      await browser.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Polls fn in the page until it returns a truthy value. */
export async function until<T>(page: Page, what: string, ms: number, fn: () => T | Promise<T>): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await page.evaluate(fn);
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

/** Clears a controlled React input and types into it. */
export async function fill(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  await page.click(selector, { count: 3 });
  await page.keyboard.press('Backspace');
  // Textareas: select-all may not cover multiple lines.
  await page.$eval(selector, el => (el as HTMLInputElement).select?.());
  await page.keyboard.press('Backspace');
  if (text) await page.type(selector, text);
}

export const tid = (id: string, extra = '') => `[data-testid="${id}"]${extra}`;
