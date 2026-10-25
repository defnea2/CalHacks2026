// The tutor speaks first. The client calls startConversation on its "Start talking" click
// (the AudioContext only exists after that click, so earlier audio would be lost). That
// records the request as turnState = thinking on a session without turns, plus a turn_metrics
// row at OPENING_TURN_IDX whose turnEndAt is the click. The worker sees the state through its
// subscription and starts an opening reply with beginOpening (instead of beginUtterance, which
// answers a student turn). addSentence / appendTutorTurn / recordMetric then work as usual.
import { SenderError } from 'spacetimedb/server';
import { OPENING_TURN_IDX, type TurnState, type TurnStatus } from '../../shared/src/types';
import { type Ctx, findSentence, getActiveSession, metricsFor, metricsForUtterance, sessionTurns, updateSession } from './ctx';

const LISTENING: TurnState = 'listening';
const THINKING: TurnState = 'thinking';
const T_OPEN: TurnStatus = 'open';
const T_CLOSING: TurnStatus = 'closing';

function openingMetrics(ctx: Ctx, sessionId: bigint) {
  for (const m of ctx.db.turnMetrics.bySessionTurn.filter([sessionId, OPENING_TURN_IDX])) return m;
  return undefined;
}

/** True while nothing has been said yet: no tutor turn and no finished student turn
 *  (a student turn still open, e.g. noise right after the click, does not count). */
function nothingSaidYet(ctx: Ctx, sessionId: bigint): boolean {
  return sessionTurns(ctx, sessionId).every(t => t.role === 'student' && (t.status === T_OPEN || t.status === T_CLOSING));
}

/**
 * Client: "Start talking" was clicked. Asks the worker for an opening reply if the session has
 * no turns yet. A no-op (not an error) when the conversation already started, an opening was
 * already requested, or the tutor is busy, so reloads and repeated clicks never greet twice.
 */
export function startConversation(ctx: Ctx, sessionId: bigint): void {
  const session = getActiveSession(ctx, sessionId);
  if (session.turnCount > 0 || sessionTurns(ctx, sessionId).length) return;
  if (openingMetrics(ctx, sessionId)) return;
  if (session.turnState !== LISTENING || session.currentUtteranceId !== 0n) return;
  const m = metricsFor(ctx, sessionId, OPENING_TURN_IDX);
  ctx.db.turnMetrics.id.update({ ...m, turnEndAt: ctx.timestamp });
  updateSession(ctx, session, { turnState: THINKING });
}

/** Agent: starts the opening utterance (accepted once, only before anything was said). */
export function beginOpening(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint }): void {
  const session = getActiveSession(ctx, args.sessionId);
  if (args.utteranceId === 0n) throw new SenderError('utteranceId must be non-zero');
  if (findSentence(ctx, args.utteranceId, 0) || metricsForUtterance(ctx, args.sessionId, args.utteranceId)) {
    throw new SenderError(`utterance ${args.utteranceId} already exists`);
  }
  const m = openingMetrics(ctx, args.sessionId);
  if (!m) throw new SenderError('no opening was requested (startConversation)');
  if (m.utteranceId !== 0n) throw new SenderError(`the opening already started (utterance ${m.utteranceId})`);
  if (!nothingSaidYet(ctx, args.sessionId)) throw new SenderError('the conversation already started');
  if (session.currentUtteranceId !== 0n) throw new SenderError(`utterance ${session.currentUtteranceId} is speaking`);
  updateSession(ctx, session, { currentUtteranceId: args.utteranceId });
  ctx.db.turnMetrics.id.update({ ...m, utteranceId: args.utteranceId, preemptive: false });
}
