// Starts / ends a simulated class from the command line (same reducers as the teacher UI).
// The simulated students talk to the real tutor, so the worker must run (pnpm worker).
//
// Usage:
//   node scripts/simulate.mjs [--preset A|B|C] [--n 6] [--teacher "Ms. Park"] [--no-reset]
//                             [--goals ...] [--content ...] [--delivery ...]
//   node scripts/simulate.mjs --end [--teacher "Ms. Park"]     ends that teacher's running class
//   node scripts/simulate.mjs --reset-only [--n 0]             simulated students 1..n (0 = all 20)
//                                                              back to fresh seed memories
//   SPACETIME_DB=<name> selects the database (default voice-tutor), SPACETIME_SERVER the server
//   (default local; a non-local server needs --yes-remote). --dry-run prints the spacetime
//   commands and runs none.
//
// --reset (default, like the UI checkbox) resets simulated students 1..n to their seed memories
// before the class starts; --no-reset keeps their memory and history from earlier runs.
// Presets are the copy-paste classes of docs/DEMO.md. The CLI registers as agent (AGENT_SECRET):
// teacher reducers are otherwise only for the device signed in as that teacher.
import { assertTarget, call, db, dryRun, registerAgent, sql, target } from './stdb-cli.mjs';

const PRESETS = {
  A: {
    goals: 'Add fractions with the same denominator',
    content: '1/4 + 2/4, 2/6 + 3/6, 1/5 + 2/5',
    delivery: 'Use pictures first, short sentences. Explain why the bottom number stays the same.',
    n: 6,
  },
  B: {
    goals: 'Compare decimals using tenths and hundredths',
    content: 'Compare 0.3 and 0.25, then 0.5 and 0.45',
    delivery: 'Use a hundred grid or money. Let the child say which is bigger before showing the numbers.',
    n: 6,
  },
  C: {
    goals: 'Find equivalent fractions by multiplying top and bottom',
    content: 'Expand 2/3 to twelfths, 3/4 to eighths',
    delivery: 'Pizza or chocolate bar pictures first, then the rule. One step at a time.',
    n: 4,
  },
};
const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:5175';

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}
function die(msg) {
  console.error(`simulate: ${msg}`);
  process.exit(1);
}

const presetKey = String(opt('--preset', 'A')).toUpperCase();
const preset = PRESETS[presetKey] ?? die(`unknown preset ${presetKey} (A, B or C)`);
const nArg = opt('--n', undefined);
const n = nArg === undefined ? undefined : Number(nArg);
if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 20)) die('--n must be an integer 0-20');
const teacherName = opt('--teacher', 'Ms. Park').trim();
if (flag('--reset') && flag('--no-reset')) die('use --reset or --no-reset, not both');
const reset = !flag('--no-reset');

const activeClasses = teacherId =>
  sql(`SELECT * FROM class_session WHERE teacher_id = ${teacherId}`).filter(c => c.active === 'true');

function findTeacher(create) {
  let t = sql('SELECT * FROM teacher').filter(x => x.name === teacherName).sort((a, b) => Number(a.id) - Number(b.id))[0];
  if (!t && create) {
    call('create_teacher', [JSON.stringify(teacherName)]);
    if (dryRun) return { id: '<teacher id>' };
    console.log(`created teacher "${teacherName}"`);
    t = sql('SELECT * FROM teacher').filter(x => x.name === teacherName).sort((a, b) => Number(b.id) - Number(a.id))[0];
  }
  return t;
}

try {
  assertTarget('simulate');
  // Teacher reducers check the caller (auth.ts): the operator CLI acts as agent (AGENT_SECRET).
  registerAgent();
  if (flag('--reset-only')) {
    const count = n ?? 0;
    call('reset_simulated_students', [String(count)]);
    console.log(`${db}: simulated students 1..${count || 20} reset to their seed memories`);
  } else if (flag('--end')) {
    const t = findTeacher(false) ?? (dryRun ? { id: '<teacher id>' } : die(`no teacher "${teacherName}" in ${db}`));
    const running = activeClasses(t.id);
    if (!running.length) console.log(`${db}: ${teacherName} has no running class`);
    for (const c of running) {
      call('end_class_session', [String(c.id)]);
      console.log(`${db}: ended class ${c.id} of ${teacherName}`);
    }
  } else {
    const t = findTeacher(true);
    const before = new Set(activeClasses(t.id).map(c => c.id));
    const goals = opt('--goals', preset.goals);
    const content = opt('--content', preset.content);
    const delivery = opt('--delivery', preset.delivery);
    const count = n ?? preset.n;
    // teacherId, goals, content, delivery, documentName, documentMime, documentText, documentData, simulatedCount, resetSimulated
    call('start_class_session_with', [
      String(t.id), JSON.stringify(goals), JSON.stringify(content), JSON.stringify(delivery),
      '""', '""', '""', '[]', String(count), String(reset),
    ]);
    if (dryRun) process.exit(0);
    const cls = activeClasses(t.id).filter(c => !before.has(c.id)).sort((a, b) => Number(b.id) - Number(a.id))[0]
      ?? activeClasses(t.id).sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!cls) die('class did not start');
    console.log(`${db}: class ${cls.id} started for ${teacherName} (teacher ${t.id}), preset ${presetKey}, ${count} simulated students${count ? (reset ? ', fresh memories' : ', memories kept') : ''}`);
    console.log(`class id: ${cls.id}`);
    console.log(`dashboard: ${CLIENT_URL}/?class=${cls.id}`);
    const envPrefix = `${target.local ? '' : `SPACETIME_SERVER=${target.server} `}${db === 'voice-tutor' ? '' : `SPACETIME_DB=${db} `}`;
    console.log(`end it:    ${envPrefix}node scripts/simulate.mjs --end${teacherName === 'Ms. Park' ? '' : ` --teacher ${JSON.stringify(teacherName)}`}${target.local ? '' : ' --yes-remote'}`);
    if (count) console.log('(the simulated students need the worker: pnpm worker)');
  }
} catch (e) {
  console.error(`simulate: ${e.message}`);
  if (target.local) console.error('Is the local server running (pnpm stdb:start) and the module published (node scripts/publish.mjs)?');
  process.exit(1);
}
