// Dev tool: initial subscription size of the worker's query set (rows per table, approximate
// bytes, time to onApplied) on a database. `SPACETIME_DB=<scratch> tsx src/measure-subscriptions.ts [old|new|both]`
// `old` = the table-wide set the worker used before its JOIN subscriptions on active sessions.
import { DbConnection } from './module_bindings/index';
import { loadConfig } from './env';
import { SUBSCRIPTIONS } from './stdb';

const cfg = loadConfig();
const OLD = [
  'SELECT * FROM session WHERE active = true',
  'SELECT * FROM turn',
  'SELECT * FROM phrase',
  'SELECT * FROM reply_sentence',
  'SELECT * FROM board_item',
  'SELECT * FROM learner',
  'SELECT * FROM speech_activity',
  'SELECT * FROM playback_flush',
  "SELECT * FROM tutor_request WHERE status = 'pending'",
];
const TABLES = ['session', 'turn', 'phrase', 'replySentence', 'boardItem', 'learner', 'tutorRequest'] as const;
const size = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? x.length : x)).length;

async function measure(label: string, queries: string[]): Promise<void> {
  const conn = await new Promise<DbConnection>((resolve, reject) =>
    DbConnection.builder().withUri(cfg.spacetimeUri).withDatabaseName(cfg.spacetimeDb).onConnect(c => resolve(c)).onConnectError((_c, e) => reject(e)).build()
  );
  const started = Date.now();
  await new Promise<void>((r, j) => conn.subscriptionBuilder().onApplied(() => r()).onError(e => j(e)).subscribe(queries));
  const ms = Date.now() - started;
  const db = conn.db as unknown as Record<string, { iter(): Iterable<unknown> }>;
  let rows = 0;
  let bytes = 0;
  const per: string[] = [];
  for (const t of TABLES) {
    const all = [...db[t]!.iter()];
    rows += all.length;
    bytes += size(all);
    per.push(`${t}=${all.length}`);
  }
  console.log(`${label}: ${rows} rows, ~${(bytes / 1024).toFixed(1)} KiB JSON, applied in ${ms} ms (${per.join(' ')})`);
  conn.disconnect();
}

const mode = process.argv[2] ?? 'both';
if (mode !== 'new') {
  await measure('old (table-wide)', OLD);
}
if (mode !== 'old') {
  await measure('new (active sessions, JOIN)', SUBSCRIPTIONS);
}
process.exit(0);
