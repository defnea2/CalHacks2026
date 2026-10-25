// Reducer round trip and fan-out micro-benchmark against the local tutor-lat database.
// Measures, per payload size, pushAudio call -> promise resolved (caller round trip) and
// call -> phrase row update seen by a second, observing connection (fan-out). Repeats with
// confirmed reads on/off and with downlink compression gzip/none.
// Usage (from worker/ so the bindings resolve): ./node_modules/.bin/tsx ../e2e/latency/bench-reducers.ts [n=60]
import { performance } from 'node:perf_hooks';
import { DbConnection } from '../../worker/src/module_bindings/index';

const URI = process.env.SPACETIME_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.SPACETIME_DB ?? 'tutor-lat';
const N = Number(process.argv[2] ?? 60);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function connect(opts: { confirmed?: boolean; compression?: 'gzip' | 'none' }): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let b = DbConnection.builder().withUri(URI).withDatabaseName(DB);
    if (opts.confirmed !== undefined) b = b.withConfirmedReads(opts.confirmed);
    if (opts.compression) b = b.withCompression(opts.compression);
    b.onConnect(c => resolve(c))
      .onConnectError((_c, e) => reject(e))
      .build();
  });
}

function subscribe(conn: DbConnection, qs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.subscriptionBuilder().onApplied(() => resolve()).onError(e => reject(e)).subscribe(qs);
  });
}

const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};
const stat = (a: number[]) => `n=${a.length} p50=${q(a, 0.5).toFixed(2)} p95=${q(a, 0.95).toFixed(2)} max=${Math.max(...a).toFixed(2)}`;

async function main() {
  const setup = await connect({});
  await subscribe(setup, ['SELECT * FROM learner', 'SELECT * FROM session WHERE active = true']);
  const name = `Bench${Date.now() % 100000}`;
  await setup.reducers.createTestUser({ name, age: 9, grade: 4, style: '' });
  await sleep(100);
  const learner = [...setup.db.learner.iter()].find(l => l.name === name)!;
  await setup.reducers.startSession({ learnerId: learner.id, taskText: 'bench' });
  await sleep(100);
  const session = [...setup.db.session.iter()].find(s => s.learnerId === learner.id && s.active)!;
  const sessionId = session.id;
  console.log(`session ${sessionId}`);
  let phraseId = 1000;
  const results: string[] = [];

  for (const mode of [
    { label: 'default (gzip, server-default reads)', opts: {} },
    { label: 'confirmed=false', opts: { confirmed: false } },
    { label: 'confirmed=true', opts: { confirmed: true } },
    { label: 'compression=none', opts: { compression: 'none' as const } },
  ]) {
    const caller = await connect(mode.opts);
    const observer = await connect(mode.opts);
    await subscribe(observer, [`SELECT * FROM phrase WHERE session_id = ${sessionId}`]);
    await subscribe(caller, [`SELECT * FROM phrase WHERE session_id = ${sessionId}`]);
    const seenObs = new Map<string, number>();
    const seenSelf = new Map<string, number>();
    const key = (p: number, last: number) => `${p}:${last}`;
    observer.db.phrase.onInsert((_c, r) => seenObs.set(key(r.phraseId, r.lastSeq), performance.now()));
    observer.db.phrase.onUpdate((_c, _o, r) => seenObs.set(key(r.phraseId, r.lastSeq), performance.now()));
    caller.db.phrase.onInsert((_c, r) => seenSelf.set(key(r.phraseId, r.lastSeq), performance.now()));
    caller.db.phrase.onUpdate((_c, _o, r) => seenSelf.set(key(r.phraseId, r.lastSeq), performance.now()));
    for (const bytes of [2, 5120, 14336, 32000, 64000]) {
      const pcm = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) pcm[i] = (i * 31) & 0xff;
      const p = ++phraseId;
      const rtt: number[] = [];
      const fan: number[] = [];
      const self: number[] = [];
      for (let i = 0; i < N + 5; i++) {
        const t0 = performance.now();
        await caller.reducers.pushAudio({ sessionId, phraseId: p, seq: i, pcm, final: false });
        const t1 = performance.now();
        // wait for the observer update (max 200 ms)
        for (let k = 0; k < 200 && !seenObs.has(key(p, i)); k++) await sleep(1);
        if (i >= 5) {
          rtt.push(t1 - t0);
          if (seenObs.has(key(p, i))) fan.push(seenObs.get(key(p, i))! - t0);
          if (seenSelf.has(key(p, i))) self.push(seenSelf.get(key(p, i))! - t0);
        }
        await sleep(20);
      }
      results.push(`${mode.label.padEnd(38)} ${String(bytes).padStart(6)} B  call->resolved ${stat(rtt)} | call->observer row ${stat(fan)} | call->own row ${stat(self)}`);
      console.log(results[results.length - 1]);
    }
    caller.disconnect();
    observer.disconnect();
  }
  await setup.reducers.endSession({ sessionId });
  setup.disconnect();
  await sleep(200);
  process.exit(0);
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
