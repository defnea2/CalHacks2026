// Reads the test database with the CLI (the CLI identity owns the database, so private tables
// such as memory_note are readable) and its module logs.
import { spawnSync } from 'node:child_process';
import { NO_PROXY, ROOT, SPACETIME } from './env';

const run = (args: string[]) =>
  spawnSync(SPACETIME, args, { cwd: ROOT, env: { ...process.env, ...NO_PROXY }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export type Row = Record<string, unknown>;

/** Runs a query; returns rows as objects. Throws on CLI errors. */
export function sql(db: string, query: string): Row[] {
  const r = run(['sql', '--no-config', '-s', 'local', '--format', 'json', db, query]);
  if (r.status !== 0) throw new Error(`spacetime sql failed: ${r.stderr || r.stdout}`);
  return parseSqlJson(r.stdout);
}

/** The CLI prints one JSON document per statement: either [{schema, rows}] or {schema, rows}. */
export function parseSqlJson(out: string): Row[] {
  const start = out.search(/[[{]/);
  if (start < 0) return [];
  const doc = JSON.parse(out.slice(start));
  const results = Array.isArray(doc) ? doc : [doc];
  const rows: Row[] = [];
  for (const res of results) {
    const cols: string[] = (res.schema?.elements ?? []).map((e: { name?: { some?: string } | string }, i: number) =>
      typeof e.name === 'string' ? e.name : (e.name?.some ?? `c${i}`)
    );
    for (const r of res.rows ?? []) rows.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }
  return rows;
}

/** Module log lines (text format). */
export function logs(db: string): string[] {
  const r = run(['logs', '--no-config', '-s', 'local', db]);
  return (r.stdout ?? '').split('\n');
}
