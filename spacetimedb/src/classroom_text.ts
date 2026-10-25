// Text turns for the classroom simulation. Delegates to the text-mode pipeline
// (night/pipeline) once merged; until then a minimal stand-in with the same semantics.
import type { TurnState, TurnStatus } from '../../shared/src/types';
import { type Ctx, getActiveSession, metricsFor, updateSession } from './ctx';
import { onTurnAppended } from './memory';
import { interrupt } from './voice_out';
import { liveStudentTurn } from './voice_in';

const READY: TurnStatus = 'ready';
const DONE: TurnStatus = 'done';
const THINKING: TurnState = 'thinking';

/** Appends a complete student turn (status ready) from text. */
export function appendTextTurn(ctx: Ctx, sessionId: bigint, text: string, _intent: string, _source: string): void {
  let session = getActiveSession(ctx, sessionId);
  if (session.currentUtteranceId !== 0n) interrupt(ctx, sessionId);
  const live = liveStudentTurn(ctx, sessionId);
  if (live) ctx.db.turn.id.update({ ...live, status: DONE, closedAt: ctx.timestamp });
  session = ctx.db.session.id.find(sessionId)!;
  const idx = session.turnCount;
  session = updateSession(ctx, session, { turnCount: idx + 1 });
  ctx.db.turn.insert({
    id: 0n,
    sessionId,
    idx,
    role: 'student',
    text: text.trim(),
    status: READY,
    pendingPhrases: 0,
    utteranceId: 0n,
    interrupted: false,
    createdAt: ctx.timestamp,
    closedAt: ctx.timestamp,
  });
  const m = metricsFor(ctx, sessionId, idx);
  ctx.db.turnMetrics.id.update({ ...m, turnEndAt: ctx.timestamp, sttDoneAt: ctx.timestamp });
  updateSession(ctx, ctx.db.session.id.find(sessionId)!, { turnState: THINKING });
  onTurnAppended(ctx, sessionId);
}
