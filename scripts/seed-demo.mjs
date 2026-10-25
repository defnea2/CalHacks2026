// Seeds the demo users (real students + teachers) from scripts/demo-seed.json into a LOCAL database.
// Idempotent: users are matched by name; existing ones are skipped (and differences reported),
// nothing is ever changed or deleted. No secrets: plain client reducers via the spacetime CLI.
//
// Usage: node scripts/seed-demo.mjs [--dry-run] [--file path/to/seed.json]
//        SPACETIME_DB=voice-tutor (default) selects the database; always --server local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spacetimeCommand } from './spacetime.mjs';
import { ROOT } from './env.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const fileAt = argv.indexOf('--file');
const seedFile = fileAt >= 0 ? path.resolve(argv[fileAt + 1]) : path.join(ROOT, 'scripts', 'demo-seed.json');
const db = process.env.SPACETIME_DB || 'voice-tutor';

const env = {
  ...process.env,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  PATH: `${os.homedir()}/.local/bin:${process.env.PATH}`,
};
const { command, prefix } = spacetimeCommand(env);

function cli(args) {
  // --no-config + a neutral cwd: never pick up spacetime.json (which could point elsewhere).
  const r = spawnSync(command, [...prefix, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  if (r.error) throw new Error(`could not run spacetime: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`spacetime ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Parses the `spacetime sql` table output into objects (string cells are JSON-quoted). */
function sql(query) {
  const lines = cli(['sql', '--no-config', '--server', 'local', db, query])
    .split('\n')
    .filter(l => l.includes('|') || /^-+\+/.test(l));
  const sep = lines.findIndex(l => /^-+\+/.test(l));
  if (sep < 1) return [];
  const header = lines[sep - 1].split('|').map(s => s.trim());
  return lines.slice(sep + 1).map(line => {
    const cells = line.split('|').map(s => s.trim());
    const row = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? '';
      try {
        row[h] = v.startsWith('"') ? JSON.parse(v) : v;
      } catch {
        row[h] = v;
      }
    });
    return row;
  });
}

function call(reducer, ...args) {
  const shown = `${reducer} ${args.join(' ')}`;
  if (dryRun) return console.log(`  [dry-run] ${shown}`);
  cli(['call', '--no-config', '--server', 'local', db, reducer, ...args]);
}

// ---------------------------------------------------------------- validate the data file

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
  console.log(`seeding ${db} (local) from ${path.relative(ROOT, seedFile)}${dryRun ? ' (dry run)' : ''}`);
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
    console.log(`  + student "${name}", ${s.age}, grade ${s.grade}, "${style}"`);
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
    console.log(`  + teacher "${name}"`);
  }
  if (!dryRun) {
    const real = sql('SELECT * FROM learner WHERE is_simulated = false');
    console.log(`\nreal students in ${db}:`);
    for (const l of real) console.log(`  ${String(l.id).padStart(3)}  ${l.name}, ${l.age}, grade ${l.grade}, "${l.style}"`);
    console.log(`teachers in ${db}:`);
    for (const t of sql('SELECT * FROM teacher')) console.log(`  ${String(t.id).padStart(3)}  ${t.name}`);
  }
} catch (e) {
  console.error(`seed-demo: ${e.message}`);
  console.error('Is the local server running (pnpm stdb:start) and the module published (node scripts/publish.mjs)?');
  process.exit(1);
}
