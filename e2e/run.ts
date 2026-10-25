// Automated E2E suite: isolated stack (own database, worker, client), generated student speech
// as fake microphone in headless Chrome, scenarios driven through the UI, assertions against
// page events/DOM and the database. Prints a table and writes e2e/last-run.json.
//
//   pnpm test:e2e                       # everything
//   pnpm test:e2e -- --only interrupt   # some scenarios (ids, comma separated)
//   pnpm test:e2e -- --no-retry         # no retry of external failures
//
// External API failures (Cartesia / OpenRouter connect errors, timeouts, 429/5xx, seen in the
// module or worker logs for that session) count as `external`, not as failures; such a scenario
// (or parallel group) is retried once.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OPENING_TURN_IDX } from '@tutor/shared';
import { E2E_DIR, FIXTURES, OUT_DIR, ROOT } from './lib/env';
import { externalEvidence, loadFixture, runScenario, type Check, type RunContext, type ScenarioRun } from './lib/scenario';
import { countMemoryNotes, learnerIdOf } from './lib/server';
import { logs, sql } from './lib/sql';
import { freePort, up, type Stack } from './lib/stack';
import { wordRecall } from './lib/text';
import { E2E_DEFAULTS, GROUPS, type Group, type Scenario } from './scenarios';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('--only')?.split(',').map(s => s.trim());
const noRetry = args.includes('--no-retry');
const regen = args.includes('--regen');

const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function ensureFixtures(): void {
  const names = new Set(GROUPS.flatMap(g => g.scenarios.map(s => s.fixture)));
  const missing = [...names].filter(n => !fs.existsSync(path.join(FIXTURES, `${n}.wav`)) || !fs.existsSync(path.join(FIXTURES, `${n}.json`)) || !loadFixture(n).text);
  if (!missing.length && !regen) return;
  log(`generating fixtures (${regen ? 'requested' : `missing: ${missing.join(', ')}`})`);
  const r = spawnSync('pnpm', ['--filter', 'e2e', 'gen-speech'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('gen-speech failed');
}

interface GroupResult {
  group: string;
  runs: ScenarioRun[];
  checks: Check[];
}

async function runGroup(g: Group, stack: Stack, outDir: string, runTag: string, attempt: number, scenarios: Scenario[]): Promise<ScenarioRun[]> {
  const ctx: RunContext = { db: stack.db, baseUrl: stack.clientUrl, runTag, attempt, outDir, log };
  if (g.parallel) {
    log(`group ${g.name}: ${scenarios.map(s => s.id).join(' + ')} in parallel (attempt ${attempt})`);
    return Promise.all(scenarios.map(s => runScenario(s, ctx)));
  }
  const out: ScenarioRun[] = [];
  for (const s of scenarios) {
    log(`scenario ${s.id} (attempt ${attempt})`);
    out.push(await runScenario(s, ctx));
  }
  return out;
}

function classify(runs: ScenarioRun[], stack: Stack): void {
  const moduleLog = logs(stack.db);
  const workerLog = stack.workerLines();
  for (const r of runs) {
    r.externalEvidence = externalEvidence(r, moduleLog, workerLog);
    if (r.status === 'fail' && r.externalEvidence.length) r.status = 'external';
  }
}

/** No crosstalk between parallel sessions: each page only saw its own rows, and its
 *  transcript matches its own fixture better than the others'. */
function crosstalkCheck(runs: ScenarioRun[]): Check {
  const issues: string[] = [];
  for (const r of runs) {
    if (!r.page || !r.server) {
      issues.push(`${r.id}: no data`);
      continue;
    }
    for (const o of runs) {
      if (o === r || !o.server) continue;
      const otherU = new Set(o.server.sentences.map(s => s.utteranceId));
      const otherB = new Set(o.server.boardItems.map(b => b.id));
      const leakU = r.page.sentences.filter(s => otherU.has(s.utteranceId)).length;
      const leakB = r.page.boardItems.filter(b => otherB.has(b.id)).length;
      if (leakU || leakB) issues.push(`${r.id} shows ${leakU} sentence(s) / ${leakB} board item(s) of ${o.id}`);
      if (r.fixture !== o.fixture) {
        const own = wordRecall(r.sourceText, r.transcript);
        const foreign = wordRecall(o.sourceText, r.transcript);
        if (foreign >= own) issues.push(`${r.id} transcript matches ${o.id}'s text (${foreign.toFixed(2)}) as well as its own (${own.toFixed(2)})`);
      }
    }
  }
  const ids = runs.map(r => r.sessionId);
  if (new Set(ids).size !== ids.length) issues.push(`duplicate session ids ${ids.join(',')}`);
  return { name: 'no-crosstalk', status: issues.length ? 'fail' : 'pass', detail: issues.length ? issues.join('; ') : `${runs.length} sessions (${ids.join(', ')}) fully isolated` };
}

async function memoryCheck(stack: Stack, runs: ScenarioRun[]): Promise<Check> {
  // Extraction runs as a scheduled procedure (LLM call): give it some time.
  const deadline = Date.now() + 45_000;
  let notes = 0;
  let cursors = 0;
  while (Date.now() < deadline) {
    notes = countMemoryNotes(stack.db);
    cursors = sql(stack.db, 'SELECT * FROM extraction_cursor').filter(r => Number(r.next_idx) > 0).length;
    const pending = sql(stack.db, 'SELECT COUNT(*) AS n FROM extraction_job')[0];
    if (notes > 0 && Number(pending?.n ?? 0) === 0) break;
    await sleep(2000);
  }
  const learners = new Set(runs.filter(r => r.sessionId).map(r => learnerIdOf(stack.db, r.sessionId)));
  return {
    name: 'memory',
    status: notes > 0 ? 'pass' : cursors > 0 ? 'warn' : 'fail',
    detail: `${notes} memory_note row(s), extraction cursor advanced in ${cursors} session(s) (MEMORY_EVERY_N_TURNS=${E2E_DEFAULTS.moduleEnv.MEMORY_EVERY_N_TURNS}, ${learners.size} learners)`,
  };
}

// ---------------------------------------------------------------- report

const SYM: Record<string, string> = { pass: 'ok', fail: 'FAIL', warn: 'warn', skip: '-' };

function printReport(results: GroupResult[], globalChecks: Check[], externalFlakes: number): void {
  const runs = results.flatMap(g => g.runs);
  const names = [...new Set(runs.flatMap(r => r.checks.map(c => c.name)))];
  const short = (n: string) => n.replace('responds-to-interruption', 'responds').replace('dropped-sentences', 'dropped').replace('barge-in-stop', 'bi-stop').replace('own-data-only', 'own-data').replace('noise-indicator', 'noise').replace('turn-metrics', 'metrics').replace('student-turns', 'turns').replace('single-turn', '1-turn').replace('metrics-noise', 'm-noise').replace('interrupted-turn', 'int-turn');
  const head = ['scenario', 'result', 'try', ...names.map(short), 'audio ms', 'local ms'];
  const rows = runs.map(r => [
    r.id,
    r.status.toUpperCase(),
    String(r.attempt),
    ...names.map(n => SYM[r.checks.find(c => c.name === n)?.status ?? 'skip']!),
    r.metrics.filter(m => m.utteranceId !== '0' && m.turnIdx !== OPENING_TURN_IDX).map(m => m.firstAudio ?? '–').join('/') || '–',
    r.localLatencyMs.map(String).join('/') || '–',
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join('  ');
  console.log('\n' + line(head));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('');
  for (const r of runs) {
    for (const c of r.checks) if (c.status === 'fail' || c.status === 'warn') console.log(`  ${r.id} ${c.name} [${c.status}]: ${c.detail}`);
    for (const e of r.externalEvidence.slice(0, 3)) console.log(`  ${r.id} external: ${e.slice(0, 240)}`);
  }
  for (const c of [...results.flatMap(g => g.checks), ...globalChecks]) console.log(`  ${c.name} [${SYM[c.status]}]: ${c.detail}`);
  const stat = (label: string, opening: boolean) => {
    const lat = runs
      .flatMap(r => r.metrics.filter(m => m.utteranceId !== '0' && (m.turnIdx === OPENING_TURN_IDX) === opening).map(m => m.firstAudio))
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    if (!lat.length) return;
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
    console.log(`  latency ${label} (server): n=${lat.length} min ${lat[0]} p50 ${p(0.5)} max ${lat[lat.length - 1]} ms${opening ? '' : ` (target ${E2E_DEFAULTS.latencyTargetMs})`}`);
  };
  stat('turn end → first audio', false);
  stat('"Start talking" → opening first audio', true);
  console.log(`  external flakes: ${externalFlakes}`);
}

let dbUsed = E2E_DEFAULTS.db;

async function main(): Promise<number> {
  ensureFixtures();
  const runTag = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const outDir = path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const groups = GROUPS.map(g => ({ ...g, scenarios: g.scenarios.filter(s => !only || only.includes(s.id)) })).filter(g => g.scenarios.length);
  if (!groups.length) throw new Error(`no scenarios match --only ${only?.join(',')}`);

  const stack = await up({ db: E2E_DEFAULTS.db, clientPort: await freePort(E2E_DEFAULTS.clientPort), moduleEnv: E2E_DEFAULTS.moduleEnv, log });
  log(`stack up: ${stack.clientUrl}?db=${stack.db}`);
  dbUsed = stack.db;
  const results: GroupResult[] = [];
  const globalChecks: Check[] = [];
  let externalFlakes = 0;
  const allAttempts: ScenarioRun[] = [];
  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    void stack.down().then(() => process.exit(130));
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    for (const g of groups) {
      let runs = await runGroup(g, stack, outDir, runTag, 1, g.scenarios);
      classify(runs, stack);
      allAttempts.push(...runs);
      const ext = runs.filter(r => r.status === 'external');
      externalFlakes += ext.length;
      if (ext.length && !noRetry && !interrupted) {
        log(`external failure in ${ext.map(r => r.id).join(', ')}: retrying ${g.parallel ? 'the group' : 'once'}`);
        const again = g.parallel ? g.scenarios : g.scenarios.filter(s => ext.some(r => r.id === s.id));
        const retried = await runGroup(g, stack, outDir, runTag, 2, again);
        classify(retried, stack);
        allAttempts.push(...retried);
        externalFlakes += retried.filter(r => r.status === 'external').length;
        runs = runs.map(r => retried.find(x => x.id === r.id) ?? r);
      }
      const checks = g.parallel ? [crosstalkCheck(runs)] : [];
      results.push({ group: g.name, runs, checks });
      for (const r of runs) log(`${r.id}: ${r.status}${r.status !== 'pass' ? ` (${r.checks.filter(c => c.status === 'fail').map(c => c.name).join(', ')})` : ''}`);
    }
    const all = results.flatMap(g => g.runs);
    const mem = await memoryCheck(stack, all);
    // Nothing to extract when every conversation failed on an external API.
    if (mem.status === 'fail' && all.every(r => r.status === 'external')) mem.status = 'skip';
    globalChecks.push(mem);
  } finally {
    await stack.down();
    log('stack down');
  }

  printReport(results, globalChecks, externalFlakes);
  const runs = results.flatMap(g => g.runs);
  const failed =
    runs.some(r => r.status === 'fail') ||
    results.some(g => g.checks.some(c => c.status === 'fail' && !g.runs.some(r => r.status === 'external'))) ||
    globalChecks.some(c => c.status === 'fail');
  const report = {
    startedAt: new Date(t0).toISOString(),
    durationS: Math.round((Date.now() - t0) / 1000),
    db: dbUsed,
    moduleEnv: E2E_DEFAULTS.moduleEnv,
    result: failed ? 'fail' : runs.some(r => r.status === 'external') ? 'pass-with-external' : 'pass',
    externalFlakes,
    outDir: path.relative(E2E_DIR, outDir),
    groups: results.map(g => ({
      group: g.group,
      checks: g.checks,
      scenarios: g.runs.map(({ page: _p, server: _s, ...r }) => r),
    })),
    checks: globalChecks,
    attempts: allAttempts.map(r => ({ id: r.id, attempt: r.attempt, status: r.status, failed: r.checks.filter(c => c.status === 'fail').map(c => c.name), externalEvidence: r.externalEvidence })),
  };
  fs.writeFileSync(path.join(E2E_DIR, 'last-run.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.result.toUpperCase()} in ${report.durationS} s — e2e/last-run.json, raw dumps in e2e/${report.outDir}`);
  return failed ? 1 : 0;
}

main().then(
  code => process.exit(code),
  e => {
    console.error(e);
    process.exit(2);
  }
);

