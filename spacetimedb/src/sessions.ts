// Learners and sessions.
import { SenderError } from 'spacetimedb/server';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { pack } from '../../shared/src/lesson/index';
import type { SentenceStatus, TurnState } from '../../shared/src/types';
import { type Ctx, type SessionRow, getSession, updateSession, utteranceSentences } from './ctx';
import { scheduleSessionEnd } from './memory';
import { closeLiveTurns } from './voice_in';

const LISTENING: TurnState = 'listening';
const DROPPED: SentenceStatus = 'dropped';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createTestUser(ctx: Ctx, args: { name: string; age: number; grade: number; style: string }) {
  const name = args.name.trim();
  if (!name || name.length > 40) throw new SenderError('name must be 1-40 characters');
  if (args.age < 5 || args.age > 18) throw new SenderError('age must be between 5 and 18');
  if (args.grade > 13) throw new SenderError('grade must be at most 13');
  return ctx.db.learner.insert({
    id: 0n,
    name,
    age: args.age,
    grade: args.grade,
    style: args.style.trim().slice(0, 200),
    createdAt: ctx.timestamp,
  });
}

function sessionCode(ctx: Ctx): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[ctx.random.integerInRange(0, CODE_CHARS.length - 1)];
  return code;
}

export function startSession(ctx: Ctx, args: { learnerId: bigint; taskText: string }): SessionRow {
  if (!ctx.db.learner.id.find(args.learnerId)) throw new SenderError(`learner ${args.learnerId} not found`);
  for (const s of [...ctx.db.session.learnerId.filter(args.learnerId)]) if (s.active) closeSession(ctx, s);
  const session = ctx.db.session.insert({
    id: 0n,
    learnerId: args.learnerId,
    code: sessionCode(ctx),
    taskText: args.taskText.trim().slice(0, 2000),
    phase: pack.initialPhase,
    turnState: LISTENING,
    category: '',
    concept: '',
    packVersion: pack.version,
    active: true,
    hasImage: false,
    turnCount: 0,
    currentUtteranceId: 0n,
    startedAt: ctx.timestamp,
    endedAt: undefined,
  });
  ctx.db.extractionCursor.insert({ sessionId: session.id, nextIdx: 0 });
  return session;
}

export function uploadPhoto(ctx: Ctx, args: { sessionId: bigint; mime: string; data: Uint8Array }): void {
  const session = getSession(ctx, args.sessionId);
  if (!session.active) throw new SenderError('session has ended');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(args.mime)) throw new SenderError('photo must be jpeg, png, webp or gif');
  if (args.data.length === 0) throw new SenderError('empty photo');
  if (args.data.length > MODULE_DEFAULTS.PHOTO_MAX_BYTES) throw new SenderError(`photo too large (max ${MODULE_DEFAULTS.PHOTO_MAX_BYTES} bytes)`);
  const row = { sessionId: session.id, mime: args.mime, data: args.data };
  if (ctx.db.sessionImage.sessionId.find(session.id)) ctx.db.sessionImage.sessionId.update(row);
  else ctx.db.sessionImage.insert(row);
  updateSession(ctx, session, { hasImage: true });
}

export function endSession(ctx: Ctx, sessionId: bigint): void {
  const session = getSession(ctx, sessionId);
  if (!session.active) return;
  closeSession(ctx, session);
}

function closeSession(ctx: Ctx, session: SessionRow): void {
  closeLiveTurns(ctx, session.id);
  if (session.currentUtteranceId !== 0n) {
    for (const s of utteranceSentences(ctx, session.id, session.currentUtteranceId)) {
      if (s.status === 'pending' || s.status === 'ready') ctx.db.replySentence.id.update({ ...s, status: DROPPED });
    }
  }
  for (const c of [...ctx.db.audioIn.sessionId.filter(session.id)]) ctx.db.audioIn.id.delete(c.id);
  const fresh = ctx.db.session.id.find(session.id)!;
  updateSession(ctx, fresh, { active: false, endedAt: ctx.timestamp, turnState: LISTENING, currentUtteranceId: 0n });
  scheduleSessionEnd(ctx, session.id);
}
