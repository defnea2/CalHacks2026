// TEMPORARY (night/client-static): contract-shaped stubs of the docs/CONTRACT-night.md section 1
// lesson tables/reducers that night/pipeline has not pushed yet, so the client can generate
// bindings and a scripted "agent" can drive the UI. No validation. Reverted before the merge.
import { type Ctx, getActiveSession, updateSession } from './ctx';
import { queueTextSentence } from './text_mode';
import { appendTutorTurn, tutorTurnFor } from './voice_out';

export function submitInteraction(ctx: Ctx, args: { sessionId: bigint; kind: string; payload: string }) {
  getActiveSession(ctx, args.sessionId);
  ctx.db.learnerEvent.insert({ id: 0n, sessionId: args.sessionId, kind: args.kind, payload: args.payload, accepted: true, evidence: '', createdAt: ctx.timestamp });
}

export function addBeat(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint; idx: number; visual: string; narration: string }) {
  let session = getActiveSession(ctx, args.sessionId);
  if (session.currentUtteranceId !== args.utteranceId) session = updateSession(ctx, session, { currentUtteranceId: args.utteranceId, turnState: 'speaking' });
  const sentence = ctx.db.replySentence.insert({
    id: 0n, sessionId: session.id, utteranceId: args.utteranceId, idx: args.idx, display: args.narration, speech: args.narration,
    status: session.voice ? 'pending' : 'ready', createdAt: ctx.timestamp,
  });
  if (!session.voice) queueTextSentence(ctx, session, sentence);
  const prev = ctx.db.canvasState.sessionId.find(session.id);
  const version = (prev?.version ?? 0) + 1;
  ctx.db.beat.insert({ id: 0n, sessionId: session.id, utteranceId: args.utteranceId, idx: args.idx, visual: args.visual, narration: args.narration, sentenceIdx: sentence.idx, canvasVersion: version, createdAt: ctx.timestamp });
}

export function stubFinishUtterance(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint }) {
  if (tutorTurnFor(ctx, args.sessionId, args.utteranceId)) return;
  const text = [...ctx.db.replySentence.sessionId.filter(args.sessionId)].filter(s => s.utteranceId === args.utteranceId).sort((a, b) => a.idx - b.idx).map(s => s.display).join(' ');
  appendTutorTurn(ctx, { sessionId: args.sessionId, utteranceId: args.utteranceId, text, interrupted: false });
}

export function stubLessonState(ctx: Ctx, args: { sessionId: bigint; stage: string; awaitingResponse: boolean; checkPrompt: string; notes: string }) {
  const row = { sessionId: args.sessionId, stage: args.stage, awaitingResponse: args.awaitingResponse, checkPrompt: args.checkPrompt, evidence: '[]', notes: args.notes, updatedAt: ctx.timestamp };
  if (ctx.db.lessonState.sessionId.find(args.sessionId)) ctx.db.lessonState.sessionId.update(row);
  else ctx.db.lessonState.insert(row);
}

export function stubAgentStatus(ctx: Ctx, args: { model: string }) {
  const row = { id: 0, model: args.model, provider: 'stub', busySessions: 0, lastSeen: ctx.timestamp };
  if (ctx.db.agentStatus.id.find(0)) ctx.db.agentStatus.id.update(row);
  else ctx.db.agentStatus.insert(row);
}
