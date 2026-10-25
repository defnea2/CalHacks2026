// Debug: runs the harness UI flow once and records URL changes, render errors and the DOM around
// the session-screen step. Usage: tsx spikes/flow-debug.ts <clientUrl with ?db=...>
import { launch } from '../lib/browser';
import { createSessionViaUi } from '../lib/ui';

const base = process.argv[2]!;
const b = await launch(null);
const log: string[] = [];
const page = await b.newPage('dbg', m => log.push(m));
page.on('framenavigated', f => f === page.mainFrame() && log.push(`nav ${f.url()}`));
page.on('pageerror', e => log.push(`pageerror ${e.message}`));
page.on('console', m => m.type() === 'error' && log.push(`console.error ${m.text().slice(0, 200)}`));
try {
  const id = await createSessionViaUi(page, base, `Dbg ${Date.now() % 100000}`, 'Expand 2/3 to twelfths');
  log.push(`ok session ${id}`);
} catch (e) {
  log.push(`FAIL ${(e as Error).message}`);
  const html = await page.evaluate(() => document.querySelector('main')?.innerHTML.slice(0, 600) ?? document.body.innerHTML.slice(0, 600));
  log.push(`main: ${html}`);
  const ev = await page.evaluate(() => (window.__tutor?.events ?? []).filter(e => /render_error|reducer\.(error|call)|route|nav/.test(e.type)).slice(-12));
  log.push(`events: ${JSON.stringify(ev).slice(0, 1500)}`);
}
console.log(log.join('\n'));
await b.close();
