// Spike: the one session screen against the REAL module lesson pipeline, with this script playing
// the worker through the CLI (no LLM, no TTS): text-mode session → typed question → beginUtterance,
// beginLesson(meta), addBeat × n (the team's mini lesson fixture) → the canvas, captions, the check
// and the observer; then a learner manipulation (math_action) and a typed answer.
//   BASE=http://127.0.0.1:5185 DB=night-client npx tsx spikes/lesson-ui.ts
// The CLI identity registers as the agent of DB (AGENT_SECRET from .env.local), so use your own DB.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, fill, tid, until } from '../lib/browser';
import { createSessionViaUi } from '../lib/ui';
import { NO_PROXY, OUT_DIR, ROOT, SPACETIME, findEnvDir, parseEnvFile } from '../lib/env';
import { miniMeta, miniMoments } from '../../teaching/test/fixtures';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5185';
const DB = process.env.DB ?? 'night-client';
if (['voice-tutor', 'tutor', 'night-base'].includes(DB)) throw new Error(`refusing to act as agent on ${DB}`);
const cli = (...args: string[]) => execFileSync(SPACETIME, args, { env: { ...process.env, ...NO_PROXY }, stdio: 'pipe', cwd: '/tmp' }).toString();
const call = (reducer: string, ...args: unknown[]) => cli('call', '--no-config', '--server', 'local', DB, reducer, ...args.map(a => JSON.stringify(a)));
const sql = (q: string) => cli('sql', '--no-config', '--server', 'local', DB, q);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const secret = parseEnvFile(path.join(ROOT, '.env.local')).AGENT_SECRET ?? parseEnvFile(path.join(findEnvDir(), '.env.local')).AGENT_SECRET;

async function main() {
  if (!secret) throw new Error('AGENT_SECRET missing (.env.local)');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  call('register_agent', secret);
  call('agent_heartbeat', 'claude-haiku-5-5 (script)', 'cli', 0);
  const b = await launch(null);
  const logs: string[] = [];
  try {
    const page = await b.newPage('session', m => logs.push(m));
    const sid = Number(await createSessionViaUi(page, `${BASE}/?db=${DB}&voice=0`, `Lesson ${Date.now() % 100000}`, 'Equivalent fractions'));
    console.log('session', sid, 'mode', await page.$eval(tid('session-screen'), el => el.getAttribute('data-mode')));
    await until(page, 'agent online', 10_000, () => document.querySelector('[data-testid="agent-status"]')?.getAttribute('data-online') === 'true');
    await fill(page, tid('text-input'), 'Why is 2/4 the same as 1/2?');
    await page.click(tid('text-send'));
    await until(page, 'typed caption', 10_000, () => !!document.querySelector('[data-testid="caption-student"]'));
    const idx = Number(/\n\s*(\d+)\s*$/.exec(sql(`SELECT idx FROM turn WHERE session_id = ${sid} AND role = 'student'`).trim())?.[1]);
    const U = BigInt(Date.now());
    call('begin_utterance', sid, Number(U), idx, false);
    call('begin_lesson', sid, Number(U), JSON.stringify(miniMeta));
    const t0 = Date.now();
    for (let i = 0; i < miniMoments.length; i++) {
      const { narration, ...rest } = miniMoments[i]!;
      const final = i === miniMoments.length - 1;
      call('add_beat', sid, Number(U), i, JSON.stringify(final ? { ...rest, final: true } : rest), narration);
      if (i === 0) {
        await until(page, 'first beat on the canvas', 10_000, () => document.querySelector('[data-testid="lesson-canvas"]')?.getAttribute('data-shown') === '1');
        console.log(`first beat visible ${Date.now() - t0} ms after add_beat`);
      }
    }
    const text = miniMoments.map(m => m.narration).join(' ');
    call('append_tutor_turn', sid, Number(U), text, false);
    // Text playback: Skip to question, then the check opens once the module marks the lesson presented.
    await until(page, 'playback bar', 10_000, () => !!document.querySelector('[data-testid="playback-skip"]'));
    await page.click(tid('playback-skip'));
    const shown = await until(page, 'all beats shown', 10_000, () => {
      const el = document.querySelector('[data-testid="lesson-canvas"]');
      return el && el.getAttribute('data-shown') === el.getAttribute('data-beats') ? el.getAttribute('data-shown') : null;
    });
    console.log('beats shown', shown);
    await until(page, 'check open', 60_000, () => !!document.querySelector('[data-testid="check-prompt"]'));
    console.log('check:', await page.$eval(tid('check-prompt'), e => e.textContent), '| stage', await page.$eval(tid('lesson-stage'), e => `${e.getAttribute('data-stage')}/${e.getAttribute('data-phase')} "${e.textContent}"`));
    await page.screenshot({ path: path.join(OUT_DIR, 'lesson-ui-check.png') });
    // Learner manipulation on the interactive final picture (bars): any enabled button inside the canvas.
    const before = sql(`SELECT kind, accepted FROM learner_event WHERE session_id = ${sid}`);
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[data-testid="lesson-canvas"] button:not([disabled])')][0] as HTMLButtonElement | undefined;
      btn?.click();
      return btn?.getAttribute('aria-label') ?? btn?.textContent ?? null;
    });
    await sleep(1200);
    console.log('manipulation', clicked, '→ learner_event', sql(`SELECT kind, accepted, evidence FROM learner_event WHERE session_id = ${sid}`).trim().split('\n').slice(2).join(' | ') || '(none)', before === '' ? '' : '');
    await fill(page, tid('text-input'), 'The pieces get smaller but the shaded part stays the same size');
    await page.click(tid('text-send'));
    await sleep(1000);
    console.log('evidence:', JSON.parse(/"(\[.*\])"/.exec(sql(`SELECT evidence FROM lesson_state WHERE session_id = ${sid}`))?.[1]?.replace(/\\"/g, '"') ?? '[]').map((e: { response: { kind: string }; outcome: string; source: string }) => `${e.response.kind}:${e.outcome}/${e.source}`).join(', '));
    const obs = await b.newPage('observer', m => logs.push(m));
    await obs.goto(`${BASE}/?db=${DB}&observe=${sid}`, { waitUntil: 'domcontentloaded' });
    await until(obs, 'observer canvas', 15_000, () => {
      const el = document.querySelector('[data-testid="lesson-canvas"]');
      return el && el.getAttribute('data-shown') === el.getAttribute('data-beats');
    });
    await obs.screenshot({ path: path.join(OUT_DIR, 'lesson-ui-observer.png') });
    console.log('observer ok; inputs', await obs.$$eval('[data-testid="text-input"]', e => e.length), 'captions', await obs.$$eval('[data-testid="caption-sentence"]', e => e.length));
  } finally {
    const errs = logs.filter(l => !/WebSocket is closed before|404 \(Not Found\)/.test(l));
    if (errs.length) console.log(errs.slice(0, 20).join('\n'));
    await b.close();
  }
}
main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
