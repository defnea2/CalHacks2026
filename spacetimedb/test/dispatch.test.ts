// LLM_DISPATCH=cloudflare (docs/CLOUD_PLAN.md Part B): the module dispatches every turn to the
// Cloudflare Worker, watches it, retries once and speaks the fallback line. LLM_DISPATCH=worker
// (default) writes nothing.
import { createHmac, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { TimeDuration } from 'spacetimedb';
import { OPENING_TURN_IDX } from '../../shared/src/types';
import { FALLBACK_LINE, WATCH_FIRST_S, STALL_S } from '../src/dispatch';
import { hmacSha256, sha256, signDispatch, toHex } from '../src/hmac';
import { auth, call, makeLearner, makeSession, mod, proc, session, setup, turns, type H, type Req, type Responder } from './helpers';

const CF = { LLM_DISPATCH: 'cloudflare', CF_DISPATCH_URL: 'https://fibonacci-dispatch.example.workers.dev/dispatch', CF_DISPATCH_SECRET: 'dispatch-secret' };

function fresh(env: Record<string, string> = CF, task = 'Expand 2/3 to twelfths') {
  const e = setup(env);
  const learner = makeLearner(e.h, e.client);
  const s = makeSession(e.h, e.client, learner.id, task);
  return { ...e, s };
}
const dispatches = (h: H, sessionId: bigint) => [...h.db.llmDispatch.sessionId.filter(sessionId)].sort((a, b) => (a.id < b.id ? -1 : 1));
const advance = (h: H, s: number) => h.clock.advance(TimeDuration.fromMillis(s * 1000));

function popAll(h: H, table: 'dispatchJob' | 'dispatchWatchJob') {
  const jobs = [...(h.db[table] as any).iter()] as any[];
  h.withReducerTx(TestAuth.internal(), ctx => {
    for (const j of jobs) (ctx.db[table] as any).scheduledId.delete(j.scheduledId);
  });
  return jobs;
}
/** Runs the pending dispatch jobs; returns the requests the Worker got. */
function runDispatch(h: H, respond: (req: Req) => { status: number; body?: string } = () => ({ status: 202 })): Req[] {
  const seen: Req[] = [];
  const responder: Responder = req => {
    seen.push(req);
    return respond(req);
  };
  for (const job of popAll(h, 'dispatchJob')) (mod.dispatchTurn as any)(proc(h, TestAuth.internal() as never, responder), { job });
  return seen;
}
function runWatch(h: H): number {
  const jobs = popAll(h, 'dispatchWatchJob');
  for (const job of jobs) h.withReducerTx(TestAuth.internal(), ctx => (mod.dispatchWatch as any)(ctx, { job }));
  return jobs.length;
}
const sentences = (h: H, sessionId: bigint) => [...h.db.replySentence.sessionId.filter(sessionId)].sort((a, b) => a.idx - b.idx);

describe('hmac', () => {
  it('sha256 and HMAC-SHA256 match node:crypto', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(toHex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
    const longKey = 'k'.repeat(100);
    for (const key of ['secret', longKey]) expect(toHex(hmacSha256(key, 'héllo body'))).toBe(createHmac('sha256', key).update('héllo body').digest('hex'));
    expect(signDispatch('s', '1', 'n', '{}')).toBe(createHmac('sha256', 's').update('1.n.{}').digest('hex'));
  });
});

describe('LLM_DISPATCH=worker (default)', () => {
  it('writes no dispatch rows and lets any agent utterance begin', () => {
    const { h, client, agent, s } = fresh({});
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hi', intent: '' });
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect(dispatches(h, s.id)).toHaveLength(0);
    expect([...h.db.dispatchJob.iter()]).toHaveLength(0);
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 42n, replyToIdx: 0, preemptive: false });
    expect(session(h, s.id).currentUtteranceId).toBe(42n);
  });
});

describe('LLM_DISPATCH=cloudflare', () => {
  it('a ready turn is dispatched: signed body with the planner request, 202 -> sent, reducers -> running -> done', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'I think it is 8/12', intent: '' });
    const [d] = dispatches(h, s.id);
    expect(d).toMatchObject({ kind: 'turn', turnIdx: 0, status: 'pending', attempt: 0 });
    const [req] = runDispatch(h);
    expect(req!.uri).toBe(CF.CF_DISPATCH_URL);
    const sig = createHmac('sha256', CF.CF_DISPATCH_SECRET).update(`${req!.headers['x-dispatch-ts']}.${req!.headers['x-dispatch-nonce']}.${req!.text}`).digest('hex');
    expect(req!.headers['x-dispatch-signature']).toBe(sig);
    expect(req!.headers['x-dispatch-nonce']).toBe(`${d!.id}:0`);
    const body = JSON.parse(req!.text);
    expect(body).toMatchObject({ v: 1, kind: 'turn', sessionId: String(s.id), turnIdx: 0, utteranceId: String(d!.utteranceId), transcript: 'I think it is 8/12', image: '', turnImage: '', prelude: [] });
    expect(JSON.parse(body.built)).toMatchObject({ ok: true, request: { requestId: String(d!.utteranceId) } });
    expect(dispatches(h, s.id)[0]!.status).toBe('sent');
    expect(h.db.agentStatus.id.find(0)).toMatchObject({ provider: 'cloudflare' });

    // Only the dispatched utterance may begin (a Node worker still running, a forged id).
    expect(() => call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: 42n, replyToIdx: 0, preemptive: false })).toThrow(/not dispatched/);
    const u = d!.utteranceId;
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: u, replyToIdx: 0, preemptive: false });
    expect(dispatches(h, s.id)[0]!.status).toBe('running');
    // Duplicate delivery: a second run with the same utteranceId is rejected.
    expect(() => call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: u, replyToIdx: 0, preemptive: false })).toThrow(/not current|already exists/);
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: u, idx: 0, display: 'Nice.', speech: 'Nice.' });
    expect(dispatches(h, s.id)[0]!.firstBeatAt).toBeTruthy();
    call(h, agent, mod.appendTutorTurn, { sessionId: s.id, utteranceId: u, text: 'Nice.', interrupted: false });
    expect(dispatches(h, s.id)[0]!.status).toBe('done');
    advance(h, WATCH_FIRST_S);
    runWatch(h);
    expect(dispatches(h, s.id)).toHaveLength(1);
  });

  it('POST failure: one retry with a new utteranceId, then the fallback line closes the turn', () => {
    const { h, client, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' });
    runDispatch(h, () => ({ status: 500, body: 'boom' }));
    let ds = dispatches(h, s.id);
    expect(ds.map(d => [d.status, d.attempt])).toEqual([['failed', 0], ['pending', 1]]);
    expect(ds[0]!.error).toMatch(/HTTP 500/);
    expect(ds[1]!.utteranceId).not.toBe(ds[0]!.utteranceId);
    runDispatch(h, () => ({ status: 401 }));
    ds = dispatches(h, s.id);
    expect(ds.map(d => d.status)).toEqual(['failed', 'failed']);
    expect(sentences(h, s.id).map(x => x.display)).toEqual([FALLBACK_LINE]);
    expect(turns(h, s.id).map(t => [t.role, t.text])).toEqual([['student', 'hello'], ['tutor', FALLBACK_LINE]]);
  });

  it('watch: accepted but silent -> retry once; silent again -> fallback line', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' });
    runDispatch(h);
    // The first run began its utterance but never spoke.
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: dispatches(h, s.id)[0]!.utteranceId, replyToIdx: 0, preemptive: false });
    advance(h, WATCH_FIRST_S);
    runWatch(h);
    let ds = dispatches(h, s.id);
    expect(ds.map(d => [d.status, d.attempt])).toEqual([['failed', 0], ['pending', 1]]);
    expect(session(h, s.id).currentUtteranceId).toBe(0n); // released for the retry
    // The old run is now stale.
    expect(() => call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: ds[0]!.utteranceId, idx: 0, display: 'x', speech: 'x' })).toThrow(/not current/);
    runDispatch(h);
    advance(h, WATCH_FIRST_S + 1);
    runWatch(h);
    ds = dispatches(h, s.id);
    expect(ds.map(d => d.status)).toEqual(['failed', 'failed']);
    expect(turns(h, s.id).at(-1)).toMatchObject({ role: 'tutor', text: FALLBACK_LINE, utteranceId: ds[1]!.utteranceId });
  });

  it('a newer student turn supersedes the pending dispatch (no fallback for the old one)', () => {
    const { h, client, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'first', intent: '' });
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'second', intent: '' });
    const reqs = runDispatch(h);
    expect(reqs.map(r => JSON.parse(r.text).transcript)).toEqual(['second']);
    expect(dispatches(h, s.id).map(d => d.status)).toEqual(['superseded', 'sent']);
  });

  it('watch closes a reply that stopped after speaking', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' });
    runDispatch(h);
    const u = dispatches(h, s.id)[0]!.utteranceId;
    call(h, agent, mod.beginUtterance, { sessionId: s.id, utteranceId: u, replyToIdx: 0, preemptive: false });
    call(h, agent, mod.addSentence, { sessionId: s.id, utteranceId: u, idx: 0, display: 'Let us look.', speech: 'Let us look.' });
    advance(h, WATCH_FIRST_S);
    runWatch(h); // spoke recently: re-armed
    expect(dispatches(h, s.id)[0]!.status).toBe('running');
    advance(h, STALL_S);
    runWatch(h);
    expect(dispatches(h, s.id)[0]).toMatchObject({ status: 'failed' });
    expect(turns(h, s.id).at(-1)).toMatchObject({ role: 'tutor', text: 'Let us look.', utteranceId: u });
  });

  it('opening with a task: dispatched with the authored lead-in as prelude', () => {
    const { h, client, agent, s } = fresh();
    call(h, client, mod.startConversation, { sessionId: s.id });
    const [d] = dispatches(h, s.id);
    expect(d).toMatchObject({ kind: 'opening', turnIdx: OPENING_TURN_IDX });
    const body = JSON.parse(runDispatch(h)[0]!.text);
    expect(body.kind).toBe('opening');
    expect(body.prelude.length).toBeGreaterThan(0);
    expect(body.topic).not.toBeUndefined();
    call(h, agent, mod.beginOpening, { sessionId: s.id, utteranceId: d!.utteranceId });
    expect(dispatches(h, s.id)[0]!.status).toBe('running');
  });

  it('opening without a task: the module speaks the authored opening itself', () => {
    const { h, client, s } = fresh(CF, '');
    call(h, client, mod.startConversation, { sessionId: s.id });
    expect([...h.db.dispatchJob.iter()]).toHaveLength(0);
    expect(sentences(h, s.id).length).toBeGreaterThan(0);
    expect(turns(h, s.id)).toMatchObject([{ role: 'tutor' }]);
  });

  it('missing CF_DISPATCH_URL: fallback line at once', () => {
    const { h, client, s } = fresh({ LLM_DISPATCH: 'cloudflare' });
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' });
    expect(runDispatch(h)).toHaveLength(0);
    expect(turns(h, s.id).at(-1)).toMatchObject({ role: 'tutor', text: FALLBACK_LINE });
  });

  it('scheduled functions are scheduler-only', () => {
    const { h, client, s } = fresh();
    call(h, client, mod.submitTextTurn, { sessionId: s.id, text: 'hello', intent: '' });
    const [job] = [...h.db.dispatchWatchJob.iter()];
    expect(() => h.withReducerTx(auth('mallory'), ctx => (mod.dispatchWatch as any)(ctx, { job }))).toThrow(/scheduler only/);
    const [djob] = [...h.db.dispatchJob.iter()];
    expect(() => (mod.dispatchTurn as any)(proc(h, auth('mallory') as never), { job: djob })).toThrow(/scheduler only/);
  });
});
