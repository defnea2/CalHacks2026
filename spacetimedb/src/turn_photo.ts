// Turn photos: the learner takes a picture at any time during a session; it travels with the
// next student turn that closes (docs/ARCHITECTURE.md "turn_image").
// - attachImage stores it pending (a newer one replaces the pending one), session.pendingPhoto = true.
// - completeTurn (voice_in) calls bindPendingImage: turn_image.bound/turnIdx/usedAt, turn.hasPhoto.
// - The worker reads it with the agent-only procedure getTurnImage(sessionId, turnIdx).
import { SenderError } from 'spacetimedb/server';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { type Ctx, type SessionRow, type TurnRow, getSession, updateSession } from './ctx';

export const TURN_IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;

type TurnImageRow = NonNullable<ReturnType<Ctx['db']['turnImage']['id']['find']>>;

/** Records the identity that started an ad-hoc session (client startSession). */
export function recordOwner(ctx: Ctx, sessionId: bigint): void {
  const row = { sessionId, owner: ctx.sender };
  if (ctx.db.sessionOwner.sessionId.find(sessionId)) ctx.db.sessionOwner.sessionId.update(row);
  else ctx.db.sessionOwner.insert(row);
}

/** Only the session's learner may attach photos. There are no accounts (test users), so
 *  "owner" means: the identity that started the session, or (class sessions, started by the
 *  teacher) the connection that holds the learner's presence. Sessions with neither on record
 *  (older rows) stay open, as every other client reducer. */
export function requireOwner(ctx: Ctx, session: SessionRow): void {
  if (session.classSessionId) {
    const presence = ctx.db.presence.learnerId.find(session.learnerId);
    if (presence?.connectionId && presence.connectionId !== (ctx.connectionId?.toHexString() ?? '')) throw new SenderError('not your session');
    return;
  }
  const owner = ctx.db.sessionOwner.sessionId.find(session.id);
  if (owner && !owner.owner.isEqual(ctx.sender)) throw new SenderError('not your session');
}

function pendingOf(ctx: Ctx, sessionId: bigint): TurnImageRow[] {
  return [...ctx.db.turnImage.sessionId.filter(sessionId)].filter(r => !r.bound);
}

export function attachImage(ctx: Ctx, args: { sessionId: bigint; mime: string; data: Uint8Array }): void {
  const session = getSession(ctx, args.sessionId);
  if (!session.active) throw new SenderError('session has ended');
  requireOwner(ctx, session);
  if (!TURN_IMAGE_MIME.test(args.mime)) throw new SenderError('photo must be jpeg, png, webp or gif');
  if (args.data.length === 0) throw new SenderError('empty photo');
  if (args.data.length > MODULE_DEFAULTS.PHOTO_MAX_BYTES) throw new SenderError(`photo too large (max ${MODULE_DEFAULTS.PHOTO_MAX_BYTES} bytes)`);
  for (const r of pendingOf(ctx, session.id)) ctx.db.turnImage.id.delete(r.id);
  ctx.db.turnImage.insert({
    id: 0n,
    sessionId: session.id,
    learnerId: session.learnerId,
    mime: args.mime,
    data: args.data,
    createdAt: ctx.timestamp,
    bound: false,
    turnIdx: 0,
    usedAt: undefined,
  });
  if (!session.pendingPhoto) updateSession(ctx, session, { pendingPhoto: true });
}

export function removePendingImage(ctx: Ctx, sessionId: bigint): void {
  const session = getSession(ctx, sessionId);
  requireOwner(ctx, session);
  for (const r of pendingOf(ctx, session.id)) ctx.db.turnImage.id.delete(r.id);
  if (session.pendingPhoto) updateSession(ctx, session, { pendingPhoto: false });
}

/** A student turn with text closed (status ready): the pending photo goes with it. Returns the
 *  updated turn row. */
export function bindPendingImage(ctx: Ctx, turn: TurnRow): TurnRow {
  if (turn.role !== 'student') return turn;
  const pending = pendingOf(ctx, turn.sessionId);
  if (!pending.length) return turn;
  for (const r of pending) ctx.db.turnImage.id.update({ ...r, bound: true, turnIdx: turn.idx, usedAt: ctx.timestamp });
  const session = ctx.db.session.id.find(turn.sessionId);
  if (session?.pendingPhoto) updateSession(ctx, session, { pendingPhoto: false });
  return ctx.db.turn.id.update({ ...turn, hasPhoto: true });
}

/** Agent read path: the photo bound to `turnIdx`, else the pending one when `turnIdx` is the
 *  learner's still-open turn (a preemptive reply starts before the turn closes). */
export function turnImageFor(ctx: Ctx, sessionId: bigint, turnIdx: number): { mime: string; data: Uint8Array } | null {
  const rows = [...ctx.db.turnImage.sessionId.filter(sessionId)];
  const bound = rows.filter(r => r.bound && r.turnIdx === turnIdx).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (bound) return { mime: bound.mime, data: bound.data };
  const pending = rows.find(r => !r.bound);
  if (!pending) return null;
  const turn = [...ctx.db.turn.sessionId.filter(sessionId)].find(t => t.idx === turnIdx);
  if (turn && turn.role === 'student' && (turn.status === 'open' || turn.status === 'closing')) return { mime: pending.mime, data: pending.data };
  return null;
}
