// Seeds the demo users (real students + teachers) and the students' seed memory from
// scripts/demo-seed.json into a database (local by default), then prints a one-time sign-in code
// per demo user (valid 7 days): the accounts are created by the agent identity, so they belong to
// no device until the demo laptop redeems a code ("I have a code"; docs/DEMO.md).
// --no-codes skips the codes; re-running prints fresh codes (older ones stay valid, max 3).
// Idempotent: users are matched by name; existing ones are skipped (and differences reported),
// learner rows are never changed or deleted. Memory (`memory` per student) is written with the
// agent-only reducer seedMemory, which replaces that student's earlier SEEDED notes and seed
// summary (notes from real sessions are kept). For that the CLI identity registers as agent with
// AGENT_SECRET (shell, else .env.local; read only, never printed). On a remote server this makes
// the logged-in CLI identity (the owner) an agent of that database, and the shell AGENT_SECRET
// must be the remote one.
//
// Usage: node scripts/seed-demo.mjs [--dry-run] [--no-memory] [--no-codes] [--file path/to/seed.json] [--yes-remote]
//        SPACETIME_DB=voice-tutor (default) selects the database, SPACETIME_SERVER=local (default)
//        the server; a non-local server needs --yes-remote. --dry-run prints every spacetime
//        command and runs none (it then assumes an empty database).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { assertTarget, call as cliCall, db, dryRun, formatCode, registerAgent, signInCode, sql, target } from './stdb-cli.mjs';

const argv = process.argv.slice(2);
const withMemory = !argv.includes('--no-memory');
const withCodes = !argv.includes('--no-codes');
const fileAt = argv.indexOf('--file');
const seedFile = fileAt >= 0 ? path.resolve(argv[fileAt + 1]) : path.join(ROOT, 'scripts', 'demo-seed.json');

function call(reducer, ...args) {
  cliCall(reducer, args);
}

// ---------------------------------------------------------------- validate the data file

const KINDS = ['misconception', 'strategy', 'mnemonic', 'quote', 'understood', 'preference'];
const OUTCOMES = ['worked', 'didnt', 'unknown'];

const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const students = seed.students ?? [];
const teachers = seed.teachers ?? [];
const problems = [];
for (const s of students) {
  const n = String(s.name ?? '').trim();
  if (!n || n.length > 40) problems.push(`student "${n}": name must be 1-40 characters`);
  if (!Number.isInteger(s.age) || s.age < 5 || s.age > 18) problems.push(`student "${n}": age must be an integer 5-18`);
  if (!Number.isInteger(s.grade) || s.grade < 0 || s.grade > 13) problems.push(`student "${n}": grade must be an integer 0-13`);
  if (typeof s.style !== 'string' || s.style.length > 200) problems.push(`student "${n}": style must be a string of at most 200 characters`);
  // Quick local check; the module validates fully (taxonomy, lengths) and rejects the whole seed.
  for (const [i, note] of (s.memory?.notes ?? []).entries()) {
    if (!KINDS.includes(note.kind)) problems.push(`student "${n}" notes[${i}]: kind must be one of ${KINDS.join(', ')}`);
    if (note.outcome && !OUTCOMES.includes(note.outcome)) problems.push(`student "${n}" notes[${i}]: outcome must be one of ${OUTCOMES.join(', ')}`);
    if (!String(note.text ?? '').trim()) problems.push(`student "${n}" notes[${i}]: text is empty`);
  }
}
for (const t of teachers) {
  const n = String(t.name ?? '').trim();
  if (!n || n.length > 60) problems.push(`teacher "${n}": name must be 1-60 characters`);
}
const dupes = names => names.filter((n, i) => names.indexOf(n) !== i);
for (const d of dupes(students.map(s => s.name.trim()))) problems.push(`student "${d}" is listed twice`);
for (const d of dupes(teachers.map(t => t.name.trim()))) problems.push(`teacher "${d}" is listed twice`);
if (problems.length) {
  console.error(`${path.relative(ROOT, seedFile)}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------- seed

try {
  assertTarget('seed-demo');
  console.log(`seeding ${db} (${target.server}) from ${path.relative(ROOT, seedFile)}${dryRun ? ' (dry run)' : ''}`);
  // As agent first: accounts the agent creates belong to no device (they are handed out with codes).
  registerAgent();
  const learners = sql('SELECT * FROM learner');
  const simNames = new Set(learners.filter(l => l.is_simulated === 'true').map(l => l.name));
  for (const s of students) {
    const name = s.name.trim();
    const style = s.style.trim();
    if (simNames.has(name)) console.warn(`  ! student "${name}" has the same name as a simulated student; pick another name`);
    const have = learners.find(l => l.name === name && l.is_simulated !== 'true');
    if (have) {
      const diff = [['age', s.age], ['grade', s.grade], ['style', style]].filter(([k, v]) => String(have[k]) !== String(v));
      console.log(`  = student "${name}" exists (id ${have.id})${diff.length ? `; differs in ${diff.map(([k]) => k).join(', ')} (rows are not changed: reset with publish --clear to apply)` : ''}`);
      continue;
    }
    call('create_test_user', JSON.stringify(name), String(s.age), String(s.grade), JSON.stringify(style));
    if (!dryRun) console.log(`  + student "${name}", ${s.age}, grade ${s.grade}, "${style}"`);
  }
  const haveTeachers = sql('SELECT * FROM teacher');
  for (const t of teachers) {
    const name = t.name.trim();
    const have = haveTeachers.find(x => x.name === name);
    if (have) {
      console.log(`  = teacher "${name}" exists (id ${have.id})`);
      continue;
    }
    call('create_teacher', JSON.stringify(name));
    if (!dryRun) console.log(`  + teacher "${name}"`);
  }

  // ---- seed memory (agent-only reducer)
  const withSeedMemory = students.filter(s => s.memory);
  if (withMemory && withSeedMemory.length) {
    const real = sql('SELECT * FROM learner WHERE is_simulated = false');
    for (const s of withSeedMemory) {
      const name = s.name.trim();
      // The oldest real learner with that name (the one the seed created).
      const l = real.filter(x => x.name === name).sort((a, b) => Number(a.id) - Number(b.id))[0];
      if (!l && !dryRun) {
        console.warn(`  ! no learner "${name}" for its memory`);
        continue;
      }
      const m = s.memory;
      call('seed_memory', l ? String(l.id) : '<new id>', JSON.stringify(JSON.stringify(m)));
      if (!dryRun) {
        const kinds = (m.notes ?? []).map(n => n.kind).join(', ');
        console.log(`  ~ memory "${name}": ${(m.notes ?? []).length} notes (${kinds}), mastery ${(m.mastery ?? []).map(x => `${x.concept} ${x.mastery}`).join(', ') || '-'}${(m.summary ? 1 : 0) + (m.history?.length ?? 0) ? `, ${(m.summary ? 1 : 0) + (m.history?.length ?? 0)} past session(s)` : ''}`);
      }
    }
  }

  if (!dryRun) {
    const real = sql('SELECT * FROM learner WHERE is_simulated = false');
    const notes = withMemory ? sql('SELECT * FROM memory_note') : [];
    console.log(`\nreal students in ${db}:`);
    for (const l of real) {
      const n = notes.filter(x => x.learner_id === l.id).length;
      console.log(`  ${String(l.id).padStart(3)}  ${l.name}, ${l.age}, grade ${l.grade}, "${l.style}"${withMemory ? `, ${n} memory notes` : ''}`);
    }
    console.log(`teachers in ${db}:`);
    for (const t of sql('SELECT * FROM teacher')) console.log(`  ${String(t.id).padStart(3)}  ${t.name}`);
  }

  // ---- sign-in codes for the demo users (one-time, 7 days)
  if (withCodes) {
    const real = dryRun ? [] : sql('SELECT * FROM learner WHERE is_simulated = false');
    const allTeachers = dryRun ? [] : sql('SELECT * FROM teacher');
    const rows = [
      ...teachers.map(t => ['teacher', t.name.trim(), allTeachers.filter(x => x.name === t.name.trim()).sort((a, b) => Number(a.id) - Number(b.id))[0]]),
      ...students.map(s => ['learner', s.name.trim(), real.filter(x => x.name === s.name.trim()).sort((a, b) => Number(a.id) - Number(b.id))[0]]),
    ];
    console.log('\nsign-in codes (one-time, valid 7 days; enter under "I have a code" on the demo device):');
    for (const [kind, name, row] of rows) {
      if (!row && !dryRun) continue;
      const r = signInCode(kind, row ? row.id : '<id>');
      if (dryRun) continue;
      console.log(r.ok ? `  ${kind === 'teacher' ? 'teacher' : 'student'}  ${name.padEnd(14)} ${formatCode(r.code)}` : `  ! ${name}: ${r.error}`);
    }
  }
} catch (e) {
  console.error(`seed-demo: ${e.message}`);
  if (target.local) console.error('Is the local server running (pnpm stdb:start) and the module published (node scripts/publish.mjs)?');
  process.exit(1);
}
