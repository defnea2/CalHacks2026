// Prints a one-time sign-in code (valid 7 days) for a teacher or student, as the operator: the
// CLI registers as agent with AGENT_SECRET (shell, else .env.local). For the demo device, or to
// get an account back when every device of it was lost (cleared browser storage).
//
// Usage: node scripts/sign-in-code.mjs --teacher "Ms. Park"
//        node scripts/sign-in-code.mjs --student "Ava Chen"
//        node scripts/sign-in-code.mjs --student-id 7
//        SPACETIME_DB / SPACETIME_SERVER as in seed-demo.mjs (a non-local server needs --yes-remote).
import { assertTarget, db, dryRun, formatCode, registerAgent, signInCode, sql } from './stdb-cli.mjs';

const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const die = m => {
  console.error(`sign-in-code: ${m}`);
  process.exit(1);
};

try {
  assertTarget('sign-in-code');
  registerAgent();
  let kind;
  let row;
  if (opt('--teacher')) {
    kind = 'teacher';
    row = sql('SELECT * FROM teacher').filter(t => t.name === opt('--teacher')).sort((a, b) => Number(a.id) - Number(b.id))[0];
  } else if (opt('--student') || opt('--student-id')) {
    kind = 'learner';
    const real = sql('SELECT * FROM learner WHERE is_simulated = false');
    row = opt('--student-id') ? real.find(l => l.id === opt('--student-id')) : real.filter(l => l.name === opt('--student')).sort((a, b) => Number(a.id) - Number(b.id))[0];
  } else die('use --teacher NAME, --student NAME or --student-id ID');
  if (!row && !dryRun) die(`no such ${kind} in ${db}`);
  const r = signInCode(kind, row ? row.id : '<id>');
  if (dryRun) process.exit(0);
  if (!r.ok) die(r.error);
  console.log(`${kind === 'teacher' ? 'teacher' : 'student'} ${row.name} (id ${row.id}): ${formatCode(r.code)}  (one-time, until ${new Date(r.expiresMs).toLocaleString()})`);
} catch (e) {
  die(e.message);
}
