// Test harness helpers: identities, reducer calls, scheduled-job runners, mocked HTTP.
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, type ModuleTestHarness } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { setEnvOverride } from '../src/env';
import type { S } from '../src/ctx';

export type H = ModuleTestHarness<S>;
export type Req = { uri: string; method: unknown; headers: Record<string, string>; body: Uint8Array; text: string };
export type Responder = (req: Req, h: H) => { status: number; body?: string | Uint8Array };

export const AGENT_SECRET = 'test-secret';
export const ENV = {
  AGENT_SECRET,
  CARTESIA_API_KEY: 'cartesia-test',
  OPENROUTER_API_KEY: 'openrouter-test',
  OPENROUTER_EXTRACTION_MODEL: 'test/model',
  MEMORY_EVERY_N_TURNS: '4',
};

let conn = 1n;
export function auth(sub: string) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub, aud: ['spacetimedb'] }), new ConnectionId(conn++));
}

export function setup(env: Record<string, string> = {}) {
  setEnvOverride({ ...ENV, ...env });
  const h = createModuleTestHarness(spacetimedb, mod) as unknown as H;
  const client = auth('client');
  const agent = auth('agent');
  h.withReducerTx(TestAuth.internal(), ctx => (mod.init as any)(ctx, {}));
  call(h, agent, mod.registerAgent, { secret: AGENT_SECRET });
  return { h, client, agent };
}

export function call<A>(h: H, who: ReturnType<typeof auth>, reducer: (ctx: any, args: A) => unknown, args: A): void {
  h.withReducerTx(who, ctx => reducer(ctx, args));
}

const dec = new TextDecoder();

export function proc(h: H, who: ReturnType<typeof auth>, responder?: Responder) {
  const b = h.procedureContextBuilder(who as never);
  b.http((_t, req, body) => {
    if (!responder) throw new Error('unexpected HTTP call');
    const headers: Record<string, string> = {};
    for (const e of (req.headers as any).entries as Array<{ name: string; value: Uint8Array | Record<string, number> }>) {
      headers[e.name.toLowerCase()] = dec.decode(e.value instanceof Uint8Array ? e.value : new Uint8Array(Object.values(e.value)));
    }
    const r = responder({ uri: req.uri, method: req.method, headers, body, text: dec.decode(body) }, h);
    return { code: r.status, headers: { entries: [] }, version: { tag: 'Http11' }, body: r.body } as never;
  });
  return b.build();
}

export function makeLearner(h: H, who: ReturnType<typeof auth>, name = 'Mia') {
  call(h, who, mod.createTestUser, { name, age: 9, grade: 4, style: 'short hints, pictures' });
  return [...h.db.learner.iter()].find(l => l.name === name)!;
}

export function makeSession(h: H, who: ReturnType<typeof auth>, learnerId: bigint, taskText = 'Expand 2/3 to twelfths') {
  call(h, who, mod.startSession, { learnerId, taskText });
  return [...h.db.session.iter()].filter(s => s.learnerId === learnerId && s.active)[0]!;
}

export const session = (h: H, id: bigint) => h.db.session.id.find(id)!;
export const turns = (h: H, sessionId: bigint) => [...h.db.turn.sessionId.filter(sessionId)].sort((a, b) => a.idx - b.idx);

/** PCM of `ms` milliseconds filled with `fill`. */
export function pcm(ms: number, fill = 1): Uint8Array {
  return new Uint8Array(ms * 32).fill(fill);
}

/** Pops all due jobs from a schedule table (the harness has no scheduler). */
function popJobs<T extends { scheduledId: bigint }>(h: H, table: 'sttJob' | 'ttsJob' | 'extractionJob' | 'summaryJob'): T[] {
  const jobs = [...(h.db[table] as any).iter()] as T[];
  h.withReducerTx(TestAuth.internal(), ctx => {
    for (const j of jobs) (ctx.db[table] as any).scheduledId.delete(j.scheduledId);
  });
  return jobs;
}

export function runStt(h: H, responder?: Responder): number {
  const jobs = popJobs<any>(h, 'sttJob');
  for (const job of jobs) (mod.transcribePhrase as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}
export function runTts(h: H, responder?: Responder): number {
  const jobs = popJobs<any>(h, 'ttsJob');
  for (const job of jobs) (mod.synthesizeSentence as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}
export function runExtraction(h: H, responder?: Responder): number {
  const jobs = popJobs<any>(h, 'extractionJob');
  for (const job of jobs) (mod.extractMemory as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}
export function runSummary(h: H, responder?: Responder): number {
  const jobs = popJobs<any>(h, 'summaryJob');
  for (const job of jobs) (mod.summarizeSession as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return jobs.length;
}

export const sttOk = (text: string): Responder => () => ({ status: 200, body: JSON.stringify({ type: 'transcript', text, duration: 1 }) });

/** Student says each text as one phrase, then ends the turn; transcribes everything. */
export function studentSays(h: H, who: ReturnType<typeof auth>, sessionId: bigint, ...texts: string[]): void {
  const base = 100 + (session(h, sessionId).turnCount * 10);
  texts.forEach((_, i) => call(h, who, mod.pushAudio, { sessionId, phraseId: base + i, seq: 0, pcm: pcm(300), final: true }));
  const queue = [...texts];
  runStt(h, () => ({ status: 200, body: JSON.stringify({ text: queue.shift() }) }));
  call(h, who, mod.endTurn, { sessionId });
}

export function chatResponse(content: unknown) {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }) };
}

export { mod };
