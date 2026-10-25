// Headless multi-identity check (docs/ARCHITECTURE.md "Identity and authorization"): two browser
// contexts = two devices, plus a third identity over the HTTP API, against a local database.
//
//   pnpm --filter e2e identity-check -- --db <database>       (default identity-e2e, published --clear)
//
// Device A: creates a student, reload keeps the identity, starts a lesson; creates a teacher,
// starts a class with the student in it. Device B: cannot open A's lesson, class dashboard or
// student profile (gate), and its reducer/procedure calls are refused by the module. Then A makes
// a teacher sign-in code and B redeems it: B now runs A's teacher account. No worker needed.
import { spawn, spawnSync } from 'node:child_process';
import puppeteer, { type Page } from 'puppeteer-core';
import { CHROME, NO_PROXY, ROOT } from './lib/env';
import { fill, tid, until } from './lib/browser';
import { freePort, publish } from './lib/stack';
import { waitConnected } from './lib/ui';

const args = process.argv.slice(2);
const db = args.includes('--db') ? args[args.indexOf('--db') + 1]! : 'identity-e2e';
const HTTP = 'http://127.0.0.1:3000';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function http(pathname: string, token: string, body: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(`${HTTP}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
async function newToken(): Promise<string> {
  const r = await fetch(`${HTTP}/v1/identity`, { method: 'POST' });
  return ((await r.json()) as { token: string }).token;
}
function sqlRows(query: string): string {
  return spawnSync('spacetime', ['sql', '--no-config', '--server', 'local', db, query], { encoding: 'utf8', env: { ...process.env, ...NO_PROXY } }).stdout;
}

async function text(page: Page, sel: string): Promise<string> {
  return page.$eval(sel, el => el.textContent ?? '');
}

async function main() {
  if (!args.includes('--no-publish')) publish({ db, clientPort: 0, moduleEnv: {}, log: m => console.log(m) });
  const port = await freePort(5300);
  const vite = spawn('pnpm', ['--filter', 'client', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, ...NO_PROXY, VITE_SPACETIME_URI: 'ws://127.0.0.1:3000', VITE_SPACETIME_DB: db },
    detached: true,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'], protocolTimeout: 90_000, defaultViewport: { width: 1280, height: 1400 } });
  try {
    let a = await (await browser.createBrowserContext()).newPage();
    const b = await (await browser.createBrowserContext()).newPage();
    for (const [label, p] of [['A', a], ['B', b]] as const) {
      await p.evaluateOnNewDocument('globalThis.__name = (f) => f;');
      p.on('pageerror', e => console.log(`[${label} pageerror] ${e instanceof Error ? e.message : String(e)}`));
      p.on('console', m => m.type() === 'error' && console.log(`[${label} console] ${m.text()}`));
    }

    // ---- device A: student, persistent identity, lesson
    await a.bringToFront();
    await a.goto(base, { waitUntil: 'domcontentloaded' });
    await waitConnected(a);
    const idA = await a.$eval(tid('conn-status'), el => el.getAttribute('data-identity'));
    await a.click(tid('role-student'));
    await fill(a, tid('create-name'), 'Ada');
    await a.click(tid('create-submit'));
    await a.waitForSelector(tid('learner-item', '[data-learner-name="Ada"]'), { timeout: 15_000 });
    await a.reload({ waitUntil: 'domcontentloaded' });
    await waitConnected(a);
    const idA2 = await a.$eval(tid('conn-status'), el => el.getAttribute('data-identity'));
    check('reload keeps the device identity', Boolean(idA) && idA === idA2, `${idA?.slice(0, 10)} / ${idA2?.slice(0, 10)}`);
    await a.waitForSelector(tid('learner-item', '[data-learner-name="Ada"]'), { timeout: 15_000 });
    check('reload keeps "Continue as Ada"', true);
    const learnerId = await a.$eval(tid('learner-item', '[data-learner-name="Ada"]'), el => el.getAttribute('data-learner-id'));
    await a.click(tid('learner-item', '[data-learner-name="Ada"]'));
    await a.waitForSelector(tid('mode-self'));
    await a.click(tid('mode-self'));
    await fill(a, tid('task-text'), 'What is 1/4 + 2/4?');
    await a.click(tid('start-session'));
    await a.waitForSelector(tid('session-screen'), { timeout: 20_000 });
    const sessionId = await a.$eval(tid('session-screen'), el => el.getAttribute('data-session-id'));
    check('device A starts a lesson', Boolean(sessionId), `session ${sessionId}`);

    // ---- device B: cannot see or act as Ada
    await b.bringToFront();
    await b.goto(`${base}?student`, { waitUntil: 'domcontentloaded' });
    await waitConnected(b);
    const idB = await b.$eval(tid('conn-status'), el => el.getAttribute('data-identity'));
    check('device B has another identity', Boolean(idB) && idB !== idA);
    await sleep(800);
    check('device B does not list Ada', (await b.$(tid('learner-item', '[data-learner-name="Ada"]'))) === null);
    await b.bringToFront();
    await b.goto(`${base}?session=${sessionId}`, { waitUntil: 'domcontentloaded' });
    await b.waitForSelector(tid('account-gate'), { timeout: 15_000 });
    check('device B: lesson of A is gated', (await text(b, tid('account-gate'))).includes('another device'));
    await b.bringToFront();
    await b.goto(`${base}?student=${learnerId}`, { waitUntil: 'domcontentloaded' });
    await b.waitForSelector(tid('account-gate'), { timeout: 15_000 });
    check('device B: student page of A is gated', true);

    // ---- a third identity over HTTP: the module refuses
    const stranger = await newToken();
    const end = await http(`/v1/database/${db}/call/end_session`, stranger, [Number(sessionId)]);
    check('stranger endSession refused by the module', end.status !== 200, `${end.status} ${end.text.slice(0, 80)}`);
    const still = sqlRows(`SELECT active FROM session WHERE id = ${sessionId}`);
    check('A\'s session is still active', /true/.test(still));
    const turn = await http(`/v1/database/${db}/call/submit_text_turn`, stranger, [Number(sessionId), 'hijack', '']);
    check('stranger submitTextTurn refused', turn.status !== 200, String(turn.status));
    const pres = await http(`/v1/database/${db}/call/set_presence`, stranger, [Number(learnerId), 'waiting']);
    check('stranger setPresence refused', pres.status !== 200, String(pres.status));

    // ---- device A: teacher, class with Ada (a new tab of the same device; the lesson tab closes)
    const lessonTab = a;
    a = await lessonTab.browserContext().newPage();
    await a.evaluateOnNewDocument('globalThis.__name = (f) => f;');
    await lessonTab.close();
    await a.bringToFront();
    await a.goto(`${base}?teacher`, { waitUntil: 'domcontentloaded' });
    await waitConnected(a);
    await fill(a, tid('create-teacher-name'), 'Ms. Ada');
    await a.click(tid('create-teacher-submit'));
    await a.waitForSelector(tid('teacher-item', '[data-teacher-name="Ms. Ada"]'), { timeout: 15_000 });
    const teacherId = await a.$eval(tid('teacher-item', '[data-teacher-name="Ms. Ada"]'), el => el.getAttribute('data-teacher-id'));
    // Ada waits in the waiting room (presence) in a second tab of device A (same identity).
    const a2 = await a.browserContext().newPage();
    await a2.bringToFront();
    await a2.goto(`${base}?wait=${learnerId}`, { waitUntil: 'domcontentloaded' });
    await waitConnected(a2);
    await sleep(1500);
    await a.bringToFront();
    await a.click(tid('teacher-item', '[data-teacher-name="Ms. Ada"]'));
    await a.waitForSelector(tid('class-form'), { timeout: 15_000 });
    await fill(a, tid('class-goals'), 'Add fractions');
    await a.$eval(tid('sim-count-range'), el => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await a.click(tid('start-class'));
    await until(a, 'dashboard', 20_000, () => new URLSearchParams(location.search).has('class'));
    const classId = await a.evaluate(() => new URLSearchParams(location.search).get('class'));
    check('device A starts a class', Boolean(classId), `class ${classId}`);
    await until(a2, 'ada joins', 20_000, () => new URLSearchParams(location.search).has('session'));
    check('Ada (device A, waiting room) joined the class', true);

    // ---- device B: teacher screens of A are gated, the module refuses
    await b.bringToFront();
    await b.goto(`${base}?class=${classId}`, { waitUntil: 'domcontentloaded' });
    await b.waitForSelector(tid('account-gate'), { timeout: 15_000 });
    check('device B: dashboard of A is gated', (await text(b, tid('account-gate'))).includes('another teacher'));
    await b.bringToFront();
    await b.goto(`${base}?profile=${learnerId}&as=${teacherId}`, { waitUntil: 'domcontentloaded' });
    await b.waitForSelector(tid('account-gate'), { timeout: 15_000 });
    check('device B: profile via A\'s teacher is gated', true);
    const prof = await http(`/v1/database/${db}/call/learner_insights`, stranger, [Number(learnerId), Number(teacherId), '']);
    check('stranger learnerInsights refused', /not_your_teacher/.test(prof.text), prof.text.slice(0, 80));
    const endCls = await http(`/v1/database/${db}/call/end_class_session`, stranger, [Number(classId)]);
    check('stranger endClassSession refused', endCls.status !== 200, String(endCls.status));
    const obs = await http(`/v1/database/${db}/call/set_impersonation`, stranger, [Number(classId), Number(learnerId)]);
    check('stranger setImpersonation refused', obs.status !== 200, String(obs.status));
    const code = await http(`/v1/database/${db}/call/issue_sign_in_code`, stranger, ['teacher', Number(teacherId), 0]);
    check('stranger cannot get a sign-in code for A\'s teacher', /"ok":false|\\"ok\\":false/.test(code.text), code.text.slice(0, 80));

    // ---- sign in on another device: A makes a code, B redeems it
    await a.bringToFront();
    await a.goto(`${base}?teacher=${teacherId}`, { waitUntil: 'domcontentloaded' });
    await a.waitForSelector(tid('device-code-get'), { timeout: 15_000 });
    await a.click(tid('device-code-get'));
    await a.waitForSelector(tid('code-card'), { timeout: 15_000 });
    const signIn = await a.$eval(tid('code-card'), el => el.getAttribute('data-code'));
    check('device A shows a sign-in code with QR', Boolean(signIn) && (await a.$(tid('qr-code'))) !== null, String(signIn));
    await b.bringToFront();
    await b.goto(`${base}?teacher`, { waitUntil: 'domcontentloaded' });
    await waitConnected(b);
    await fill(b, tid('code-input'), `${signIn!.slice(0, 3).toLowerCase()} ${signIn!.slice(3)}`);
    await b.click(tid('code-submit'));
    await b.waitForSelector(tid('class-setup'), { timeout: 15_000 });
    check('device B signed in as the teacher with the code', (await b.$eval(tid('class-setup'), el => el.getAttribute('data-teacher-id'))) === teacherId);
    await b.bringToFront();
    await b.goto(`${base}?class=${classId}`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    check('device B now opens the dashboard', (await b.$(tid('account-gate'))) === null);
    await b.bringToFront();
    await b.goto(`${base}?teacher`, { waitUntil: 'domcontentloaded' });
    await waitConnected(b);
    await fill(b, tid('code-input'), signIn!);
    await b.click(tid('code-submit'));
    await b.waitForSelector(tid('code-error'), { timeout: 15_000 });
    check('the code works once', true);

    // ---- teacher adds a student, the child signs in with the code on device B
    await a.bringToFront();
    await a.goto(`${base}?teacher=${teacherId}`, { waitUntil: 'domcontentloaded' });
    await fill(a, tid('add-student-name'), 'Leo');
    await a.click(tid('add-student-submit'));
    await a.waitForSelector(tid('roster-item', '[data-learner-name="Leo"]'), { timeout: 15_000 });
    await a.click(`${tid('roster-item', '[data-learner-name="Leo"]')} ${tid('roster-code')}`);
    await a.waitForSelector(`${tid('roster-item', '[data-learner-name="Leo"]')} ${tid('code-card')}`, { timeout: 15_000 });
    const leoCode = await a.$eval(`${tid('roster-item', '[data-learner-name="Leo"]')} ${tid('code-card')}`, el => el.getAttribute('data-code'));
    const c = await (await browser.createBrowserContext()).newPage();
    await c.bringToFront();
    await c.goto(`${base}?code=${leoCode}`, { waitUntil: 'domcontentloaded' });
    await waitConnected(c);
    await c.waitForSelector(tid('code-submit'));
    await c.click(tid('code-submit'));
    await c.waitForSelector(tid('student-start'), { timeout: 15_000 });
    check('child device signs in as Leo with the teacher\'s code (link from the QR)', true);
  } finally {
    await browser.close().catch(() => {});
    try {
      process.kill(-vite.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} identity checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
