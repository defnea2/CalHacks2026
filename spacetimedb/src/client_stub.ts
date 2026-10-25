// TEMPORARY (night/client-static): contract-shaped stub reducers (docs/CONTRACT-night.md section 1)
// so the client builds and its E2E smoke can run before night/pipeline lands. No validation,
// no worker: addBeat/stubLessonState let a test script play the agent. Reverted before the merge.
import { SenderError } from 'spacetimedb/server';
import { type Ctx, getActiveSession, updateSession } from './ctx';

export function submitTextTurn(ctx: Ctx, args: { sessionId: bigint; text: string; intent: string }) {
  const session = getActiveSession(ctx, args.sessionId);
  if (!args.text.trim() && !args.intent) throw new SenderError('empty turn');
  ctx.db.turn.insert({
    id: 0n,
    sessionId: session.id,
    idx: session.turnCount,
    role: 'student',
    text: args.text.trim() || `[${args.intent}]`,
    status: 'ready',
    pendingPhrases: 0,
    utteranceId: 0n,
    interrupted: false,
    createdAt: ctx.timestamp,
    closedAt: ctx.timestamp,
    source: 'text',
    intent: args.intent,
  });
  updateSession(ctx, session, { turnCount: session.turnCount + 1, turnState: 'thinking' });
}

export function submitInteraction(ctx: Ctx, args: { sessionId: bigint; kind: string; payload: string }) {
  getActiveSession(ctx, args.sessionId);
  ctx.db.learnerEvent.insert({ id: 0n, sessionId: args.sessionId, kind: args.kind, payload: args.payload, accepted: true, evidence: '', createdAt: ctx.timestamp });
}

export function addBeat(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint; idx: number; visual: string; narration: string }) {
  const session = getActiveSession(ctx, args.sessionId);
  const sentence = ctx.db.replySentence.insert({
    id: 0n, sessionId: session.id, utteranceId: args.utteranceId, idx: args.idx, display: args.narration, speech: args.narration, status: session.voice ? 'pending' : 'played', createdAt: ctx.timestamp,
  });
  const prev = ctx.db.canvasState.sessionId.find(session.id);
  const version = (prev?.version ?? 0) + 1;
  ctx.db.beat.insert({ id: 0n, sessionId: session.id, utteranceId: args.utteranceId, idx: args.idx, visual: args.visual, narration: args.narration, sentenceIdx: sentence.idx, canvasVersion: version, createdAt: ctx.timestamp });
  if (session.currentUtteranceId !== args.utteranceId) updateSession(ctx, session, { currentUtteranceId: args.utteranceId, turnState: 'speaking' });
}

export function stubLessonState(ctx: Ctx, args: { sessionId: bigint; stage: string; awaitingResponse: boolean; checkPrompt: string; notes: string }) {
  const row = { sessionId: args.sessionId, stage: args.stage, awaitingResponse: args.awaitingResponse, checkPrompt: args.checkPrompt, evidence: '[]', notes: args.notes, updatedAt: ctx.timestamp };
  if (ctx.db.lessonState.sessionId.find(args.sessionId)) ctx.db.lessonState.sessionId.update(row);
  else ctx.db.lessonState.insert(row);
}

export function stubSetVoice(ctx: Ctx, args: { sessionId: bigint; voice: boolean }) {
  const session = getActiveSession(ctx, args.sessionId);
  updateSession(ctx, session, { voice: args.voice });
}
