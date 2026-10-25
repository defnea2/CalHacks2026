import { describe, it, expect } from 'vitest';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { auth, call, makeLearner, makeSession, mod, proc, runStt, session, setup, studentSays, turns } from './helpers';

const JPEG = 'image/jpeg';
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

function env() {
  const e = setup();
  const learner = makeLearner(e.h, e.client);
  const s = makeSession(e.h, e.client, learner.id);
  return { ...e, s };
}
const images = (h: ReturnType<typeof setup>['h'], sessionId: bigint) => [...h.db.turnImage.sessionId.filter(sessionId)];
const turnImage = (e: ReturnType<typeof env>, who: ReturnType<typeof auth>, turnIdx: number): string =>
  (mod.getTurnImage as any)(proc(e.h, who), { sessionId: e.s.id, turnIdx });

describe('turn photos', () => {
  it('only the session owner may attach or remove; mime, size and ended sessions are checked', () => {
    const e = env();
    const stranger = auth('stranger');
    expect(() => call(e.h, stranger, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(10) })).toThrow(/another device/);
    expect(() => call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: 'text/html', data: bytes(10) })).toThrow(/jpeg/);
    expect(() => call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(0) })).toThrow(/empty/);
    expect(() => call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(MODULE_DEFAULTS.PHOTO_MAX_BYTES + 1) })).toThrow(/too large/);
    call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(10) });
    expect(session(e.h, e.s.id).pendingPhoto).toBe(true);
    expect(() => call(e.h, stranger, mod.removePendingImage, { sessionId: e.s.id })).toThrow(/another device/);
    call(e.h, e.client, mod.removePendingImage, { sessionId: e.s.id });
    expect(images(e.h, e.s.id)).toHaveLength(0);
    expect(session(e.h, e.s.id).pendingPhoto).toBe(false);
    call(e.h, e.client, mod.endSession, { sessionId: e.s.id });
    expect(() => call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(10) })).toThrow(/ended/);
  });

  it('a new photo replaces the pending one', () => {
    const e = env();
    call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(10, 1) });
    call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: 'image/png', data: bytes(12, 2) });
    const rows = images(e.h, e.s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mime: 'image/png', bound: false });
  });

  it('binds to the next closed student turn (voice and text), then the next turn has none', () => {
    const e = env();
    call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(10) });
    studentSays(e.h, e.client, e.s.id, 'look at my homework');
    const [t0] = turns(e.h, e.s.id);
    expect(t0).toMatchObject({ idx: 0, status: 'ready', hasPhoto: true });
    expect(images(e.h, e.s.id)[0]).toMatchObject({ bound: true, turnIdx: 0 });
    expect(images(e.h, e.s.id)[0]!.usedAt).toBeTruthy();
    expect(session(e.h, e.s.id).pendingPhoto).toBe(false);

    call(e.h, e.client, mod.submitTextTurn, { sessionId: e.s.id, text: 'and now?', intent: '' });
    const t1 = turns(e.h, e.s.id).find(t => t.text === 'and now?')!;
    expect(t1.hasPhoto).toBe(false);
  });

  it('getTurnImage: agent only; the bound photo for its turn, the pending one only for the open turn', () => {
    const e = env();
    call(e.h, e.client, mod.attachImage, { sessionId: e.s.id, mime: JPEG, data: bytes(3, 255) });
    expect(() => turnImage(e, e.client, 0)).toThrow(/agent only/);
    expect(turnImage(e, e.agent, 0)).toBe(''); // no open turn yet
    // An open turn (speech still streaming): the pending photo is offered for a preemptive reply.
    call(e.h, e.client, mod.pushAudio, { sessionId: e.s.id, phraseId: 1, seq: 0, pcm: new Uint8Array(300 * 32).fill(1), final: false });
    const open = turns(e.h, e.s.id)[0]!;
    expect(open.status).toBe('open');
    expect(turnImage(e, e.agent, open.idx)).toBe('data:image/jpeg;base64,////');
    call(e.h, e.client, mod.pushAudio, { sessionId: e.s.id, phraseId: 1, seq: 1, pcm: new Uint8Array(300 * 32).fill(1), final: true });
    runStt(e.h, () => ({ status: 200, body: JSON.stringify({ text: 'see the photo' }) }));
    call(e.h, e.client, mod.endTurn, { sessionId: e.s.id });
    const bound = turns(e.h, e.s.id).find(t => t.hasPhoto)!;
    expect(turnImage(e, e.agent, bound.idx)).toBe('data:image/jpeg;base64,////');
    expect(turnImage(e, e.agent, bound.idx + 1)).toBe('');
  });

  it('class sessions: the learner\'s device owns the session, not the teacher', () => {
    const e = setup();
    const learner = makeLearner(e.h, e.client);
    call(e.h, e.client, mod.setPresence, { learnerId: learner.id, status: 'waiting' });
    const teacherConn = auth('teacher');
    call(e.h, teacherConn, mod.createTeacher, { name: 'Ms T' });
    const teacher = [...e.h.db.teacher.iter()][0]!;
    call(e.h, teacherConn, mod.startClassSession, { teacherId: teacher.id, goals: 'fractions', content: '', delivery: '', documentName: '', documentMime: '', documentText: '', documentData: new Uint8Array(), simulatedCount: 0 });
    const s = [...e.h.db.session.iter()].find(x => x.learnerId === learner.id && x.active)!;
    expect(s.classSessionId).not.toBe(0n);
    expect(() => call(e.h, teacherConn, mod.attachImage, { sessionId: s.id, mime: JPEG, data: bytes(5) })).toThrow(/another device/);
    call(e.h, e.client, mod.attachImage, { sessionId: s.id, mime: JPEG, data: bytes(5) });
    expect(session(e.h, s.id).pendingPhoto).toBe(true);
  });
});
