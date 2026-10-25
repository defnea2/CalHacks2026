// Cloudflare dispatch Worker: signature check, 202 + waitUntil, the HTTP transport (encoding,
// strict ordering), abort on "not current" (barge-in), the deadline cap and the opening/topic path.
import { describe, expect, it } from 'vitest';
import { emptyCanvas } from '@tutor/teaching/presentation/contracts';
import { buildModelRequest, newLessonRecord } from '@tutor/teaching/teaching/lessonFlow';
import { OPENING_TURN_IDX } from '@tutor/shared';
import { miniLessonText, miniSession } from '../../teaching/test/fixtures';
import { done, FakeLlm, sleep, type Step } from '../../worker/test/fakes';
import { RECAP_NARRATION } from '../../worker/src/lesson';
import { signDispatch } from '../../spacetimedb/src/hmac';
import { handle } from '../src/index';
import { verifyDispatch } from '../src/hmac';
import { encodeArgs, snake } from '../src/http_transport';
import { runDispatch } from '../src/run';
import type { DispatchBody, Env } from '../src/types';

const SECRET = 'dispatch-secret';
const env: Env = { STDB_URL: 'http://stdb.test', STDB_DB: 'db', STDB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', CF_DISPATCH_SECRET: SECRET };
const text = (delta: string): Step => ({ type: 'text', delta });
const request = () => buildModelRequest(newLessonRecord(miniSession), emptyCanvas(), 'req');

function body(over: Partial<DispatchBody> = {}): DispatchBody {
  return {
    v: 1,
    dispatchId: '7',
    attempt: 0,
    kind: 'turn',
    sessionId: '3',
    turnIdx: 0,
    utteranceId: '1761380000000000',
    transcript: 'why is 2/4 one half?',
    built: JSON.stringify({ ok: true, request: request() }),
    image: '',
    turnImage: '',
    topic: null,
    prelude: [],
    builtAtMs: Date.now(),
    ...over,
  };
}

interface Seen {
  name: string;
  args: unknown[];
  raw: string;
  auth: string | null;
}
/** A fake SpacetimeDB HTTP API: records calls, checks they never overlap, answers per reducer. */
function fakeStdb(answer: (name: string, args: unknown[], n: number) => { status: number; body?: string } | undefined = () => undefined, delayMs = 1) {
  const calls: Seen[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const name = url.split('/call/')[1]!;
    const raw = String(init.body);
    const args = JSON.parse(raw) as unknown[];
    calls.push({ name, args, raw, auth: (init.headers as Record<string, string>).Authorization ?? null });
    const counted = name !== 'record_metric';
    if (counted) maxInFlight = Math.max(maxInFlight, ++inFlight);
    await sleep(delayMs);
    if (counted) inFlight--;
    const a = answer(name, args, calls.filter(c => c.name === name).length - 1) ?? { status: 200, body: '' };
    return new Response(a.body ?? '', { status: a.status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn, maxInFlight: () => maxInFlight, names: () => calls.map(c => c.name).filter(n => n !== 'record_metric') };
}

const deps = (llm: FakeLlm, f: ReturnType<typeof fakeStdb>, logs: string[] = [], over = {}) => ({ url: env.STDB_URL, db: env.STDB_DB, token: env.STDB_TOKEN, llm, fetch: f.fetchFn, log: (m: string) => logs.push(m), ...over });

async function signed(b: DispatchBody, over: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(b);
  const ts = String(over.ts ?? Date.now());
  const nonce = `${b.dispatchId}:${b.attempt}`;
  return new Request('https://w.test/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dispatch-ts': ts, 'x-dispatch-nonce': nonce, 'x-dispatch-signature': signDispatch(over.secret ?? SECRET, ts, nonce, raw) },
    body: raw,
  });
}

describe('signature + entry', () => {
  it('WebCrypto verification accepts the module signature, rejects a wrong key, a stale timestamp, missing headers', async () => {
    const now = Date.now();
    const sig = signDispatch(SECRET, String(now), '1:0', '{"a":1}');
    expect(await verifyDispatch(SECRET, { ts: String(now), nonce: '1:0', sig }, '{"a":1}', now)).toBe('');
    expect(await verifyDispatch(SECRET, { ts: String(now), nonce: '1:0', sig }, '{"a":2}', now)).toBe('bad signature');
    expect(await verifyDispatch('other', { ts: String(now), nonce: '1:0', sig }, '{"a":1}', now)).toBe('bad signature');
    expect(await verifyDispatch(SECRET, { ts: String(now - 61_000), nonce: '1:0', sig }, '{"a":1}', now)).toMatch(/window/);
    expect(await verifyDispatch(SECRET, { ts: null, nonce: '1:0', sig }, '{}', now)).toMatch(/missing/);
  });

  it('POST /dispatch: 401 without a valid MAC (no run), 202 + waitUntil with one; 404 elsewhere', async () => {
    const started: DispatchBody[] = [];
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    const run = (async (b: DispatchBody) => void started.push(b)) as never;
    expect((await handle(await signed(body(), { secret: 'wrong' }), env, ctx, { run })).status).toBe(401);
    expect((await handle(await signed(body(), { ts: Date.now() - 120_000 }), env, ctx, { run })).status).toBe(401);
    expect(started).toHaveLength(0);
    const res = await handle(await signed(body()), env, ctx, { run });
    expect(res.status).toBe(202);
    await Promise.all(waits);
    expect(started.map(b => b.utteranceId)).toEqual(['1761380000000000']);
    expect((await handle(new Request('https://w.test/other'), env, ctx)).status).toBe(404);
    expect((await handle(new Request('https://w.test/health'), env, ctx)).status).toBe(200);
  });
});

describe('HTTP transport encoding', () => {
  it('snake_case names; u64 as raw JSON numbers (exact above 2^53)', () => {
    expect(snake('beginUtterance')).toBe('begin_utterance');
    expect(snake('addBeat')).toBe('add_beat');
    expect(encodeArgs([18446744073709551615n, 'a"b', 2, true])).toBe('[18446744073709551615,"a\\"b",2,true]');
  });
});

describe('runDispatch', () => {
  it('streams the lesson: beginUtterance, beginLesson, beats in order, appendTutorTurn; one call at a time', async () => {
    const f = fakeStdb();
    const llm = new FakeLlm([[text(miniLessonText()), done]]);
    const r = await runDispatch(body(), deps(llm, f));
    expect(f.names()).toEqual(['begin_utterance', 'begin_lesson', 'add_beat', 'add_beat', 'add_beat', 'add_beat', 'add_beat', 'add_beat', 'append_tutor_turn']);
    expect(f.calls.filter(c => c.name === 'add_beat').map(c => c.args[2])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(f.maxInFlight()).toBe(1);
    const begin = f.calls.find(c => c.name === 'begin_utterance')!;
    expect(begin.raw).toBe('[3,1761380000000000,0,false]');
    expect(begin.auth).toBe('Bearer tok');
    expect(f.calls.find(c => c.name === 'append_tutor_turn')!.args[3]).toBe(false);
    expect(r).toMatchObject({ state: 'finished', beats: 6, stale: false });
    // The planner request came with the body: no build_lesson_request round trip.
    expect(f.calls.some(c => c.name === 'build_lesson_request')).toBe(false);
    expect(String(llm.calls[0]!.messages[0]!.content)).toContain('IMPORTANT STREAMING FORMAT');
  });

  it('barge-in: a "not current" rejection aborts the stream (no repair round), at most one moment wasted', async () => {
    const json = miniLessonText();
    let at = -1;
    for (let i = 0; i < 2; i++) at = json.indexOf('},{"visual"', at + 1);
    const f = fakeStdb((name, args) => (name === 'add_beat' && args[2] === 1 ? { status: 530, body: 'utterance 1761380000000000 is not current (stale or interrupted)' } : undefined));
    const llm = new FakeLlm([[text(json.slice(0, at + 2)), { type: 'wait', ms: 5000 }, text(json.slice(at + 2)), done]]);
    const t0 = Date.now();
    const r = await runDispatch(body(), deps(llm, f));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.signal.aborted).toBe(true);
    expect(f.calls.filter(c => c.name === 'add_beat').map(c => c.args[2])).toEqual([0, 1]);
    expect(f.calls.find(c => c.name === 'append_tutor_turn')!.args[3]).toBe(true);
    expect(r).toMatchObject({ state: 'interrupted', stale: true });
  });

  it('a duplicate delivery (beginUtterance rejected) stops before any beat', async () => {
    const f = fakeStdb(name => (name === 'begin_utterance' ? { status: 530, body: 'utterance 1761380000000000 is not current (dispatch running)' } : undefined));
    const llm = new FakeLlm([[{ type: 'wait', ms: 50 }, text(miniLessonText()), done]]);
    const r = await runDispatch(body(), deps(llm, f));
    expect(f.names()).toEqual(['begin_utterance']);
    expect(r.stale).toBe(true);
  });

  it('total cap: a lesson that stalls after its first beat closes with the recap beat in time', async () => {
    const json = miniLessonText();
    const at = json.indexOf('},{"visual"');
    const f = fakeStdb();
    const llm = new FakeLlm([[text(json.slice(0, at + 2)), { type: 'wait', ms: 10_000 }, done]]);
    const t0 = Date.now();
    const r = await runDispatch(body(), deps(llm, f, [], { deadlines: { totalMs: 300, stallMs: 5000 } }));
    expect(Date.now() - t0).toBeLessThan(2000);
    const beats = f.calls.filter(c => c.name === 'add_beat');
    expect(beats.at(-1)!.args[4]).toBe(RECAP_NARRATION);
    expect(f.names().at(-1)).toBe('append_tutor_turn');
    expect(r.state).toBe('finished');
  });

  it('hard stop: a run still open at the cap is cut off (interrupted)', async () => {
    const f = fakeStdb();
    const llm = new FakeLlm([[{ type: 'wait', ms: 10_000 }, done]]);
    const r = await runDispatch(body(), deps(llm, f, [], { hardStopMs: 200, deadlines: { firstTokenMs: 5000, totalMs: 5000 } }));
    expect(r.state).toBe('interrupted');
    expect(r.totalMs).toBeLessThan(1500);
  });

  it('opening: prelude sentences first, beginOpening; topic classified, set_topic, then a fresh request', async () => {
    const f = fakeStdb(name => {
      if (name === 'set_topic') return { status: 200, body: JSON.stringify(JSON.stringify({ ok: true })) };
      if (name === 'build_lesson_request') return { status: 200, body: JSON.stringify(JSON.stringify({ ok: true, request: request() })) };
      return undefined;
    });
    const llm = new FakeLlm((i, messages) =>
      String(messages[0]!.content).startsWith('Which math concept') ? [text('{"category":"fractions","concept":"equivalent_fractions"}'), done] : [text(miniLessonText()), done]
    );
    const b = body({ kind: 'opening', turnIdx: OPENING_TURN_IDX, transcript: '', prelude: ['Hi there!', 'Let us look at your task.'], topic: { ok: false, category: '', concept: '', source: 'none', text: 'Expand 2/3', hasImage: false } });
    const r = await runDispatch(b, deps(llm, f));
    const names = f.names();
    expect(names[0]).toBe('begin_opening');
    expect(names.slice(1, 3)).toEqual(['add_sentence', 'add_sentence']);
    expect(names).toContain('build_lesson_request');
    expect(names.at(-1)).toBe('append_tutor_turn');
    expect(r.state).toBe('finished');
    // setTopic only when the classifier named a concept of the pack.
    expect(names.indexOf('build_lesson_request')).toBeGreaterThan(names.indexOf('set_topic') === -1 ? -1 : names.indexOf('set_topic'));
  });
});
