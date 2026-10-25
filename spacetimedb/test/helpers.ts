// Test harness helpers: identities, reducer calls, scheduled-job runners, mocked HTTP.
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, type ModuleTestHarness } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { setEnvOverride } from '../src/env';
import type { S } from '../src/ctx';
import { base64 } from '../src/providers';

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
export function popJobs<T extends { scheduledId: bigint }>(h: H, table: 'sttJob' | 'ttsJob' | 'extractionJob' | 'summaryJob' | 'textPlayJob'): T[] {
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
/** Runs the text-mode reading jobs (all, or only those due at or before `untilMicros`), in due order. */
export function runTextPlay(h: H, untilMicros?: bigint): number {
  const at = (j: any): bigint => (typeof j.scheduledAt.value === 'bigint' ? j.scheduledAt.value : j.scheduledAt.value.microsSinceUnixEpoch);
  const jobs = ([...(h.db.textPlayJob as any).iter()] as any[]).filter(j => at(j) <= (untilMicros ?? 1n << 62n)).sort((a, b) => (at(a) < at(b) ? -1 : 1));
  h.withReducerTx(TestAuth.internal(), ctx => {
    for (const j of jobs) (ctx.db.textPlayJob as any).scheduledId.delete(j.scheduledId);
  });
  for (const job of jobs) h.withReducerTx(TestAuth.internal(), ctx => (mod.finishTextSentence as any)(ctx, { job }));
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

/** A Cartesia /tts/sse body: audio in two base64 chunks, optional word timestamps (seconds). */
export function ttsSse(audio: Uint8Array, words: Array<[string, number, number]> = []): string {
  const half = Math.floor(audio.length / 2);
  const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = frame('chunk', { done: false, status_code: 206, data: base64(audio.subarray(0, half)) });
  if (words.length) {
    out += frame('timestamps', { done: false, word_timestamps: { words: words.slice(0, 1).map(w => w[0]), start: [words[0]![1]], end: [words[0]![2]] } });
    const rest = words.slice(1);
    if (rest.length) out += frame('timestamps', { done: false, word_timestamps: { words: rest.map(w => w[0]), start: rest.map(w => w[1]), end: rest.map(w => w[2]) } });
  }
  out += frame('chunk', { done: false, status_code: 206, data: base64(audio.subarray(half)) });
  return out + frame('done', { done: true, status_code: 200 });
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

/** Anthropic Messages API response; leading thinking block like adaptive thinking produces. */
export function anthropicResponse(content: unknown, over: { stopReason?: string; text?: string; stopDetails?: unknown } = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: over.text ?? JSON.stringify(content) },
      ],
      stop_reason: over.stopReason ?? 'end_turn',
      stop_details: over.stopDetails ?? null,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  };
}

export type Provider = 'openrouter' | 'anthropic';
export const PROVIDER_ENV: Record<Provider, Record<string, string>> = {
  openrouter: {},
  anthropic: { ANTHROPIC_API_KEY: 'anthropic-test' }, // MEMORY_PROVIDER unset: key present -> anthropic
};
/** Successful JSON answer in the given provider's wire format. */
export const llmOk = (p: Provider, content: unknown) => (p === 'anthropic' ? anthropicResponse(content) : chatResponse(content));
/** The user prompt of an LLM request in either wire format. */
export function userPrompt(p: Provider, req: Req): string {
  const body = JSON.parse(req.text);
  return p === 'anthropic' ? body.messages[0].content : body.messages[1].content;
}

export { mod };
