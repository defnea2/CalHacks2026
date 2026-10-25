// Debug: one real voice turn (fake mic) and a dump of the animated math canvas over time.
// Usage: tsx spikes/canvas-debug.ts <clientUrl with ?db=...> <fixture name>
import path from 'node:path';
import { launch } from '../lib/browser';
import { FIXTURES } from '../lib/env';
import { createSessionViaUi, startTalking } from '../lib/ui';
import { E2E_DEFAULTS } from '../scenarios';

const [base, fixture = 'correct-step'] = process.argv.slice(2);
const b = await launch(path.join(FIXTURES, `${fixture}.wav`), E2E_DEFAULTS.openingLeadMs);
const log: string[] = [];
const page = await b.newPage('canvas', m => log.push(m));
const id = await createSessionViaUi(page, base!, `Canvas ${Date.now() % 100000}`, 'Expand 2/3 so the bottom number is 12.');
console.log('session', id);
await startTalking(page);
for (let s = 0; s < 75; s += 5) {
  await new Promise(r => setTimeout(r, 5000));
  const snap = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="animated-math-board"]');
    const ev = (window.__tutor?.events ?? []).filter(e => /board|render_error|play_start/.test(e.type)).length;
    return { board: el ? el.innerHTML.slice(0, 300) : null, items: document.querySelectorAll('[data-testid="board-item"]').length, ev };
  });
  console.log(`${s + 5}s`, JSON.stringify(snap));
}
const errs = await page.evaluate(() => (window.__tutor?.events ?? []).filter(e => e.type === 'ui.render_error'));
console.log('render errors', JSON.stringify(errs).slice(0, 800));
console.log(log.filter(l => /error|Error/.test(l)).slice(-10).join('\n'));
await b.close();
