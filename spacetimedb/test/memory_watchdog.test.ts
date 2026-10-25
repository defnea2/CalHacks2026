// Extraction watchdog (backup job for a crashed run) and summary_job dedupe (memory.ts).
import { describe, it, expect } from 'vitest';
import { TimeDuration } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { pack } from '../../shared/src/lesson/index';
import { scheduleSessionEnd } from '../src/memory';
import { call, chatResponse, makeLearner, makeSession, mod, runExtraction, runSummary, runTts, session, setup, studentSays, ttsSse, type H } from './helpers';

const cat = pack.taxonomy.find(c => c.concepts.length > 1)!;
const item = { action: 'create', noteId: 0, kind: 'strategy', category: cat.key, concept: cat.concepts[0]!.key, text: 'Pizza slices make fractions click', outcome: 'worked', confidence: 0.9, evidence: { fromTurn: 0, toTurn: 1, quote: 'oh like pizza' } };
const at = (j: any): bigint => (typeof j.scheduledAt.value === 'bigint' ? j.scheduledAt.value : j.scheduledAt.value.microsSinceUnixEpoch);

function exchange(h: H, env: ReturnType<typeof setup>, sessionId: bigint, utt: bigint, student: string, tutor: string) {
  studentSays(h, env.client, sessionId, student);
  const replyToIdx = session(h, sessionId).turnCount - 1;
  call(h, env.agent, mod.beginUtterance, { sessionId, utteranceId: utt, replyToIdx, preemptive: false });
  call(h, env.agent, mod.addSentence, { sessionId, utteranceId: utt, idx: 0, display: tutor, speech: tutor });
  runTts(h, () => ({ status: 200, body: ttsSse(new Uint8Array(480)) }));
  call(h, env.client, mod.markPlayed, { sessionId, utteranceId: utt, idx: 0 });
  call(h, env.agent, mod.appendTutorTurn, { sessionId, utteranceId: utt, text: tutor, interrupted: false });
}

function start() {
  const env = setup(); // openrouter, MEMORY_EVERY_N_TURNS = 4
  const learner = makeLearner(env.h, env.client);
  const s = makeSession(env.h, env.client, learner.id);
  exchange(env.h, env, s.id, 1n, 'I add the bottoms', 'Let us use pizza.');
  exchange(env.h, env, s.id, 2n, 'oh like pizza', 'Yes!');
  return { env, h: env.h, learner, s };
}

describe('extraction watchdog', () => {
  it('a running window has a backup job; a crashed run (marker left, backup queued) is taken over after the stale limit', () => {
    const { h, s, learner } = start();
    // What the procedure leaves behind if it dies during the LLM call: the state during the call.
    let during: any[] = [];
    let since = 0n;
    runExtraction(h, (_r, hh) => {
      during = [...hh.db.extractionJob.iter()];
      since = hh.db.extractionCursor.sessionId.find(s.id)!.runningSinceMicros;
      return chatResponse({ items: [], mastery: [] });
    });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ sessionId: s.id, fromIdx: 0, toIdx: 4 });
    expect(at(during[0]) - since).toBeGreaterThanOrEqual(300_000_000n);
    expect([...h.db.extractionJob.iter()]).toHaveLength(0); // the normal end deleted it

    // Re-create the crash state for a fresh window and let the backup fire.
    h.withReducerTx(TestAuth.internal(), ctx => {
      const c = ctx.db.extractionCursor.sessionId.find(s.id)!;
      ctx.db.extractionCursor.sessionId.update({ ...c, nextIdx: 0, runningSinceMicros: ctx.timestamp.microsSinceUnixEpoch });
      ctx.db.extractionJob.insert({ ...during[0], scheduledId: 0n });
    });
    expect(runExtraction(h)).toBe(1); // still running (not stale): no LLM call (no responder)
    h.withReducerTx(TestAuth.internal(), ctx => ctx.db.extractionJob.insert({ ...during[0], scheduledId: 0n }));
    h.clock.advance(TimeDuration.fromMillis(301_000));
    runExtraction(h, () => chatResponse({ items: [item], mastery: [] }));
    expect(h.db.extractionCursor.sessionId.find(s.id)).toMatchObject({ nextIdx: 4, runningSinceMicros: 0n });
    expect([...h.db.memoryNote.learnerId.filter(learner.id)].some(n => n.text === item.text)).toBe(true);
    expect([...h.db.extractionJob.iter()]).toHaveLength(0);
  });

  it('a normal run and a provider failure both remove the backup job', () => {
    const { h } = start();
    runExtraction(h, () => ({ status: 500, body: 'down' }));
    expect([...h.db.extractionJob.iter()].map(j => j.attempt)).toEqual([1]); // only the retry
    runExtraction(h, () => chatResponse({ items: [], mastery: [] }));
    expect([...h.db.extractionJob.iter()]).toHaveLength(0);
  });
});

describe('summary_job dedupe', () => {
  it('one summary job per session even if the end path runs twice', () => {
    const { env, h, s } = start();
    call(h, env.client, mod.endSession, { sessionId: s.id });
    h.withReducerTx(TestAuth.internal(), ctx => scheduleSessionEnd(ctx, s.id));
    expect([...h.db.summaryJob.iter()].filter(j => j.sessionId === s.id)).toHaveLength(1);
    runSummary(h, () => chatResponse({ summary: 'Said hi.', nextFocus: '' }));
    expect(h.db.sessionSummary.sessionId.find(s.id)?.summary).toBe('Said hi.');
  });
});
