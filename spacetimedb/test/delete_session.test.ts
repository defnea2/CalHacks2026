// Resetting a simulation user deletes its sessions and EVERY row keyed by them (deleteSessionData).
import { ScheduleAt } from 'spacetimedb';
import { describe, it, expect } from 'vitest';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { call, mod, setup, type H } from './helpers';

/** Every row of every table whose `sessionId` is `id` (generic: also catches tables added later). */
function rowsOf(h: H, id: bigint): string[] {
  const out: string[] = [];
  for (const [name, table] of Object.entries(h.db as unknown as Record<string, { iter?: () => Iterable<Record<string, unknown>> }>)) {
    if (typeof table?.iter !== 'function') continue;
    for (const r of table.iter()) if (r.sessionId === id) out.push(name);
  }
  if (h.db.session.id.find(id)) out.push('session');
  return out;
}

describe('deleteSessionData (reset of a simulation user)', () => {
  it('leaves no row of the old session in any table', () => {
    const { h, client } = setup();
    call(h, client, mod.createTeacher, { name: 'T' });
    const teacherId = [...h.db.teacher.iter()][0]!.id;
    const args = { teacherId, goals: 'g', content: 'c', delivery: '', documentName: '', documentMime: '', documentText: '', documentData: new Uint8Array(), simulatedCount: 1 };
    call(h, client, mod.startClassSession, args);
    const s = [...h.db.session.iter()].find(x => x.active)!;
    const sid = s.id;
    const now = h.clock.now();
    const later = ScheduleAt.time(now.microsSinceUnixEpoch + 3_600_000_000n);
    h.withReducerTx(TestAuth.internal(), ctx => {
      const db = ctx.db;
      db.turn.insert({ id: 0n, sessionId: sid, idx: 9, role: 'student', text: 'x', status: 'done', pendingPhrases: 0, utteranceId: 0n, interrupted: false, createdAt: now, closedAt: undefined, source: 'sim', intent: '', hasPhoto: false });
      db.replySentence.insert({ id: 0n, sessionId: sid, utteranceId: 5n, idx: 0, display: 'a', speech: 'a', status: 'played', createdAt: now });
      db.turnImage.insert({ id: 0n, sessionId: sid, learnerId: s.learnerId, mime: 'image/jpeg', data: new Uint8Array([1, 2]), createdAt: now, bound: false, turnIdx: 0, usedAt: undefined });
      db.sessionImage.insert({ sessionId: sid, mime: 'image/jpeg', data: new Uint8Array([1]) });
      db.sessionOwner.insert({ sessionId: sid, owner: ctx.sender });
      db.textPlayback.insert({ sessionId: sid, utteranceId: 5n, endsAtMicros: 1n });
      db.textPlayJob.insert({ scheduledId: 0n, scheduledAt: later, sessionId: sid, sentenceId: 1n, utteranceId: 5n, idx: 0 });
      db.ttsJob.insert({ scheduledId: 0n, scheduledAt: later, sessionId: sid, sentenceId: 1n, utteranceId: 5n, idx: 0, speech: 'a' });
      db.sttJob.insert({ scheduledId: 0n, scheduledAt: later, sessionId: sid, phraseId: 1, attempt: 0 });
      db.extractionJob.insert({ scheduledId: 0n, scheduledAt: later, sessionId: sid, learnerId: s.learnerId, fromIdx: 0, toIdx: 1, attempt: 0 });
      db.summaryJob.insert({ scheduledId: 0n, scheduledAt: later, sessionId: sid, learnerId: s.learnerId, attempt: 0 });
      if (!db.canvasState.sessionId.find(sid)) db.canvasState.insert({ sessionId: sid, version: 0, scene: '{}', updatedAt: now });
      if (!db.lessonState.sessionId.find(sid)) db.lessonState.insert({ sessionId: sid, stage: 'needs_plan', awaitingResponse: false, checkPrompt: '', evidence: '[]', notes: '{}', updatedAt: now });
      if (!db.lessonRecord.sessionId.find(sid)) db.lessonRecord.insert({ sessionId: sid, data: '{}' });
      db.lessonPlan.insert({ utteranceId: 5n, sessionId: sid, request: '{}', meta: '{}', beats: '[]', scenes: '[]', version: 0, final: true });
      db.beat.insert({ id: 0n, sessionId: sid, utteranceId: 5n, idx: 0, visual: '{}', narration: 'a', sentenceIdx: 0, canvasVersion: 1, createdAt: now });
      db.learnerEvent.insert({ id: 0n, sessionId: sid, kind: 'choice', payload: '{}', accepted: true, evidence: '{}', createdAt: now });
      const req = db.tutorRequest.insert({ id: 0n, sessionId: sid, kind: 'shear_feedback', payload: '{}', status: 'done', createdAt: now });
      db.tutorResult.insert({ requestId: req.id, sessionId: sid, ok: true, result: '{}', createdAt: now });
      db.extractionCursor.insert({ sessionId: sid, nextIdx: 0, runningSinceMicros: 0n });
    });
    expect(rowsOf(h, sid).length).toBeGreaterThan(15);
    call(h, client, mod.endClassSession, { classSessionId: [...h.db.classSession.iter()][0]!.id });
    call(h, client, mod.resetSimulatedStudents, { count: 1 });
    expect(rowsOf(h, sid)).toEqual([]);
    // The recreated simulation user keeps its seeded past (seed_session rows use pseudo ids).
    const fresh = [...h.db.learner.iter()].find(l => l.isSimulated && l.simRank === 1)!;
    expect(fresh.id).not.toBe(s.learnerId);
    expect([...h.db.seedSession.learnerId.filter(fresh.id)].length).toBeGreaterThan(0);
    expect([...h.db.seedSession.learnerId.filter(s.learnerId)]).toEqual([]);
  });
});
