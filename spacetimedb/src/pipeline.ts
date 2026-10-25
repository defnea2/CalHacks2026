// The team's lesson planner, SpacetimeDB-idiomatic (contract section 1). The worker only streams
// the model and routes its output; this module owns the lesson state and validates every change
// with the team's own code (@tutor/teaching):
//
//   buildLessonRequest (procedure) -> the planner request for the current state (ModelRequest)
//   beginLesson   (meta streamed first)   -> validated meta + phase policy, lesson_plan row
//   addBeat       (each complete moment)  -> compiled against canvas_state; beat + reply_sentence(s)
//                                            (+ tts_job in voice mode); canvas_state advances.
//                                            The final moment ({final:true}) validates the whole
//                                            step (team validateModelStep) and is accepted.
//   end of the utterance                  -> presented (awaiting_response with a check) or, when cut
//                                            short, interrupted: canvas rolls back to the last beat
//                                            the learner actually saw/heard.
//   student turns / submitInteraction     -> evidence (team assessResponse) or unscored context.
import { SenderError } from 'spacetimedb/server';
import { SentenceChunker } from '../../shared/src/chunker';
import { prepareSentence } from '../../shared/src/markers';
import type { SentenceStatus } from '../../shared/src/types';
import { emptyCanvas, type CanvasState, type VisualBeat } from '../../teaching/src/presentation/contracts';
import type { ModelRequest } from '../../teaching/src/server/planning';
import { normalizePrompt, recentCheckPrompts } from '../../teaching/src/server/plannerPrompt';
import type { Evidence, LearnerResponse, TeachingStep } from '../../teaching/src/teaching/contracts';
import { applyLearnerActivityAction, applyLearnerMathAction } from '../../teaching/src/teaching/interactions';
import {
  acceptStep,
  answerResponse,
  buildModelRequest,
  compileMoment,
  finalizeLesson,
  interruptLesson,
  newLessonRecord,
  parseBeatInput,
  parseLessonMeta,
  presented,
  publicCheck,
  recordUtterance,
  respond,
  validatorMessage,
  type LessonMeta,
  type LessonRecord,
} from '../../teaching/src/teaching/lessonFlow';
import { arcMoment, LessonArcSchema, type LessonArc } from '../../teaching/src/teaching/arc';
import { decideTurn, feedbackLine } from '../../teaching/src/teaching/intent';
import { choiceProblem, homeworkRepeat, visibleAnswer } from '../../teaching/src/teaching/checkGuards';
import { splitKeyframes } from '../../teaching/src/teaching/keyframes';
import { ADAPTIVE_ARC, conceptMaterial, DEFAULT_ARC, guessTopic, pack } from '../../shared/src/lesson/index';
import { type Ctx, type SessionRow, type TurnRow, getActiveSession, requireAgent, sessionTurns, truncate, updateSession, utteranceSentences } from './ctx';
import { readEnv } from './env';
import { describeLearner, describeMemory } from './lesson';
import { addSentence } from './voice_out';

const PLAYED: SentenceStatus = 'played';
const READY: SentenceStatus = 'ready';
const JSON_MAX = 16_000;
const INTERACTION_KINDS = ['math_action', 'activity_action', 'submit', 'choice'] as const;
/** Lesson button intents -> the team's help requests. */
const HELP: Record<string, 'another_way' | 'simpler' | 'explain'> = { another_way: 'another_way', smaller_step: 'simpler', demonstrate: 'explain' };

type CanvasRow = NonNullable<ReturnType<Ctx['db']['canvasState']['sessionId']['find']>>;
type PlanRow = NonNullable<ReturnType<Ctx['db']['lessonPlan']['utteranceId']['find']>>;

function parse(json: string, what: string): unknown {
  if (json.length > JSON_MAX) throw new SenderError(`${what} too large (max ${JSON_MAX} characters)`);
  try {
    return JSON.parse(json);
  } catch {
    throw new SenderError(`${what} is not valid JSON`);
  }
}

// ------------------------------------------------------------------ canvas_state

export function canvasRow(ctx: Ctx, sessionId: bigint): CanvasRow {
  return (
    ctx.db.canvasState.sessionId.find(sessionId) ??
    ctx.db.canvasState.insert({ sessionId, version: 0, scene: JSON.stringify(emptyCanvas()), updatedAt: ctx.timestamp })
  );
}
const sceneOf = (row: CanvasRow): CanvasState => JSON.parse(row.scene) as CanvasState;
function writeCanvas(ctx: Ctx, row: CanvasRow, scene: CanvasState): CanvasRow {
  return ctx.db.canvasState.sessionId.update({ ...row, version: row.version + 1, scene: JSON.stringify(scene), updatedAt: ctx.timestamp });
}

// ------------------------------------------------------------------ lesson record + public state

/** The lesson arc of new sessions: LESSON_ARC (module env) names a pack arc; `adaptive` = none. */
export function lessonArc(ctx: Ctx): LessonArc | undefined {
  const id = readEnv(ctx, 'LESSON_ARC') ?? DEFAULT_ARC;
  if (id === ADAPTIVE_ARC) return undefined;
  const data = pack.arcs?.[id];
  if (!data) {
    console.warn(`LESSON_ARC ${id} is not in the lesson pack; using the adaptive policy`);
    return undefined;
  }
  return LessonArcSchema.parse(data);
}

function configFor(ctx: Ctx, session: SessionRow) {
  const learner = ctx.db.learner.id.find(session.learnerId);
  const task = session.taskText.trim();
  const arc = lessonArc(ctx);
  return {
    ...(arc ? { arc } : {}),
    sessionId: `s${session.id}`,
    age: Math.min(18, Math.max(5, learner?.age ?? 9)),
    topic: truncate(task || 'Math', 1200),
    ...(task ? { originalQuestion: truncate(task, 2000) } : {}),
    lessonStyle: 'mini_lesson' as const,
    context: [],
  };
}

export function loadRecord(ctx: Ctx, session: SessionRow): LessonRecord {
  const row = ctx.db.lessonRecord.sessionId.find(session.id);
  return row ? (JSON.parse(row.data) as LessonRecord) : newLessonRecord(configFor(ctx, session));
}

function activePlan(ctx: Ctx, sessionId: bigint): PlanRow | undefined {
  for (const p of ctx.db.lessonPlan.sessionId.filter(sessionId)) if (!p.final) return p;
  return undefined;
}

export function saveRecord(ctx: Ctx, sessionId: bigint, r: LessonRecord): void {
  const data = JSON.stringify(r);
  if (ctx.db.lessonRecord.sessionId.find(sessionId)) ctx.db.lessonRecord.sessionId.update({ sessionId, data });
  else ctx.db.lessonRecord.insert({ sessionId, data });
  publishState(ctx, sessionId, r);
}

function publishState(ctx: Ctx, sessionId: bigint, r: LessonRecord): void {
  const stage = activePlan(ctx, sessionId) ? 'presenting' : r.status;
  const step = r.step;
  const row = {
    sessionId,
    stage,
    awaitingResponse: stage === 'awaiting_response',
    checkPrompt: step?.check?.prompt ?? '',
    evidence: JSON.stringify(r.evidence),
    notes: JSON.stringify({
      stepId: step?.id ?? null,
      phase: step?.phase ?? null,
      learningGoal: step?.learningGoal ?? null,
      approach: step?.approach ?? null,
      beatCount: step?.beats.length ?? 0,
      check: publicCheck(step?.check ?? null),
      // Push-back state (teaching/intent.ts): an open confirmation, the decision the next step plans for.
      pending: r.pending ? { kind: r.pending.kind, question: r.pending.question } : null,
      decision: r.config.decision ?? null,
      steps: r.history.map(s => ({ id: s.id, phase: s.phase, learningGoal: s.learningGoal, exampleProblem: s.exampleProblem ?? null })),
    }),
    updatedAt: ctx.timestamp,
  };
  if (ctx.db.lessonState.sessionId.find(sessionId)) ctx.db.lessonState.sessionId.update(row);
  else ctx.db.lessonState.insert(row);
}

/** State a new lesson may be planned from: a stale presentation counts as interrupted, and a
 *  completed lesson (return_to_problem) starts a fresh mini lesson on the next question. */
function plannable(r: LessonRecord): LessonRecord {
  if (r.status === 'presenting') return interruptLesson(r);
  if (r.status === 'completed') return { ...r, step: null, status: 'needs_plan', revision: r.revision + 1 };
  return r;
}

/** The learner profile + memory go in as one context item (not stored in the record). */
function withProfile(ctx: Ctx, session: SessionRow, r: LessonRecord): LessonRecord {
  const memory = describeMemory(ctx, session);
  const text = truncate(`Learner: ${describeLearner(ctx, session)}${memory && memory !== 'none' ? `\nMemory:\n${memory}` : ''}`, 3000);
  return { ...r, config: { ...r.config, context: [{ id: 'learner-profile', text, source: 'tutor memory' }, ...r.config.context.slice(-11)] } };
}

// ------------------------------------------------------------------ topic prefetch + library

/** What the topic can be read from: task text, the teacher's class content, the learner's first words. */
export function topicText(ctx: Ctx, session: SessionRow): string {
  const parts = [session.taskText];
  if (session.classSessionId) {
    const c = ctx.db.classSession.id.find(session.classSessionId);
    if (c) parts.push(c.goals, c.content, c.documentText.slice(0, 1500));
  }
  for (const t of sessionTurns(ctx, session.id).filter(t => t.role === 'student').slice(0, 3)) parts.push(t.text);
  return parts.map(p => p.trim()).filter(Boolean).join('\n');
}

/**
 * Topic prefetch (once per session, before the first lesson reply): the pack's keyword cues on
 * topicText; a hit is stored on the session (category/concept). Returns JSON
 * {ok, category, concept, source: 'session'|'keywords'|'none', text, hasImage}; without a concept
 * the worker may classify `text` (+ photo) with the LLM and call setTopic.
 */
export function prefetchTopic(ctx: Ctx, sessionId: bigint): string {
  let session = getActiveSession(ctx, sessionId);
  const text = truncate(topicText(ctx, session), 3000);
  if (session.concept) return JSON.stringify({ ok: true, category: session.category, concept: session.concept, source: 'session', text, hasImage: session.hasImage });
  const guess = guessTopic(pack, text);
  if (guess && (guess.concept || !session.category)) session = updateSession(ctx, session, { category: guess.category, concept: guess.concept });
  return JSON.stringify({ ok: !!session.concept, category: session.category, concept: session.concept, source: guess?.concept ? 'keywords' : 'none', text, hasImage: session.hasImage });
}

/** Library material for the planner: the full checked material of the session's concept. */
function libraryFor(session: SessionRow): Record<string, unknown> | null {
  return session.concept ? conceptMaterial(pack, session.concept) : null;
}

/** Agent: the planner request (JSON ModelRequest) for the session's current state, plus the
 *  prefetched topic and its library material ({ok, request, topic, library}). */
export function buildLessonRequest(ctx: Ctx, sessionId: bigint, requestId: string): string {
  let session = getActiveSession(ctx, sessionId);
  try {
    // Prefetch missed (no opening, or new words): the keyword guess is instant.
    if (!session.concept) {
      prefetchTopic(ctx, sessionId);
      session = getActiveSession(ctx, sessionId);
    }
    const record = loadRecord(ctx, session);
    // Authored lines for the latest learner turn (push-back / steer back): spoken first; sayOnly = no step.
    const latest = sessionTurns(ctx, session.id).filter(t => t.role === 'student').at(-1);
    const say = record.reply && latest && record.reply.turnId === `turn-${latest.id}` ? record.reply : null;
    const topic = { category: session.category, concept: session.concept };
    if (say?.sayOnly) return JSON.stringify({ ok: true, say: say.lines, sayOnly: true, topic });
    const request = buildModelRequest(withProfile(ctx, session, plannable(record)), sceneOf(canvasRow(ctx, sessionId)), requestId);
    return JSON.stringify({ ok: true, request, topic, library: libraryFor(session), ...(say ? { say: say.lines } : {}) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: validatorMessage(e) });
  }
}

// ------------------------------------------------------------------ streamed lessons

function requireCurrent(session: SessionRow, utteranceId: bigint): void {
  if (utteranceId === 0n || session.currentUtteranceId !== utteranceId) throw new SenderError(`utterance ${utteranceId} is not current (stale or interrupted)`);
}

/** Agent: the lesson meta (planned first). Validated against the current evidence before anything is spoken. */
export function beginLesson(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint; meta: string }): void {
  const session = getActiveSession(ctx, args.sessionId);
  requireCurrent(session, args.utteranceId);
  const existing = ctx.db.lessonPlan.utteranceId.find(args.utteranceId);
  // A repair round re-plans the same utterance: allowed while nothing of the first plan was spoken.
  if (existing && (existing.final || existing.beats !== '[]')) throw new SenderError(`utterance ${args.utteranceId} already has a lesson`);
  if (existing) ctx.db.lessonPlan.utteranceId.delete(args.utteranceId);
  const record = plannable(loadRecord(ctx, session));
  const canvas = canvasRow(ctx, session.id);
  const request = buildModelRequest(withProfile(ctx, session, record), sceneOf(canvas), String(args.utteranceId));
  let meta: LessonMeta;
  try {
    meta = parseLessonMeta(request, parse(args.meta, 'meta'));
  } catch (e) {
    throw new SenderError(`invalid lesson meta: ${validatorMessage(e)}`);
  }
  // Same phase policy as validateTeachingStep, checked BEFORE the first moment is spoken.
  const options = request.context.phaseOptionsAfterAssessment;
  const allowed = meta.assessment && options ? options[meta.assessment.judgement] : request.context.allowedPhases;
  // No repeated questions across steps (the team UI re-asking the same check felt like a loop).
  if (meta.check && recentCheckPrompts(request).some(p => normalizePrompt(p) === normalizePrompt(meta.check!.prompt)))
    throw new SenderError(`The check repeats a question the learner was already asked ("${meta.check.prompt}"). Ask a new question with different words or numbers.`);
  // Under an arc the homework is handed back at the end: a check may not be the original question.
  const original = request.context.session.originalQuestion;
  if (request.context.session.arc && meta.check && original && normalizePrompt(meta.check.prompt).includes(normalizePrompt(original)))
    throw new SenderError(`The check asks the learner's own homework ("${original}"). Ask a similar task with different numbers; the homework is handed back at the end.`);
  // Same homework in other words (same numbers), and a choice task without exactly one correct option.
  const checkIssue = (request.context.session.arc ? homeworkRepeat(meta.check, original) : null) ?? choiceProblem(meta.check);
  if (checkIssue) throw new SenderError(checkIssue);
  if (!allowed.includes(meta.phase)) throw new SenderError(`Phase is not supported by the current learner evidence: ${meta.phase}. Allowed: ${allowed.join(', ') || 'none'}.`);
  ctx.db.lessonPlan.insert({
    utteranceId: args.utteranceId,
    sessionId: session.id,
    request: JSON.stringify(request),
    meta: JSON.stringify(meta),
    beats: '[]',
    scenes: JSON.stringify([sceneOf(canvas)]),
    version: canvas.version,
    final: false,
  });
  saveRecord(ctx, session.id, record);
}

/** True if the utterance spoke lesson beats (its tutor turn is then recorded from the played sentences). */
export function hasLessonBeats(ctx: Ctx, sessionId: bigint, utteranceId: bigint): boolean {
  for (const b of ctx.db.beat.sessionId.filter(sessionId)) if (b.utteranceId === utteranceId) return true;
  return false;
}

/** Splits a narration into grammatical sentences (first audio sooner; the beat reveals at the first). */
function narrationSentences(narration: string): string[] {
  const chunker = new SentenceChunker({ minWords: 1, maxWords: Number.POSITIVE_INFINITY });
  const out = [...chunker.push(narration), ...chunker.flush()].map(s => s.trim()).filter(Boolean);
  return out.length ? out : [narration.trim()];
}

/** Agent: one complete moment. Compiled and validated against canvas_state, or rejected with the validator message. */
export function addBeat(ctx: Ctx, args: { sessionId: bigint; utteranceId: bigint; idx: number; visual: string; narration: string }): void {
  const session = getActiveSession(ctx, args.sessionId);
  requireCurrent(session, args.utteranceId);
  const plan = ctx.db.lessonPlan.utteranceId.find(args.utteranceId);
  if (!plan || plan.sessionId !== session.id) throw new SenderError(`no lesson for utterance ${args.utteranceId}; call beginLesson first`);
  if (plan.final) throw new SenderError('the lesson is already complete');
  const beats = JSON.parse(plan.beats) as VisualBeat[];
  if (args.idx !== beats.length) throw new SenderError(`expected beat ${beats.length}, got ${args.idx}`);
  if (beats.length >= 8) throw new SenderError('Too many lesson moments.');
  const canvas = canvasRow(ctx, session.id);
  if (canvas.version !== plan.version) throw new SenderError(`canvas changed during the lesson (version ${canvas.version}, expected ${plan.version})`);
  const request = JSON.parse(plan.request) as ModelRequest;
  let meta = JSON.parse(plan.meta) as LessonMeta;
  const record = loadRecord(ctx, session);

  let compiled: { beat: VisualBeat; planned: CanvasState };
  let final = false;
  let accepted: { step: TeachingStep; evidence: Evidence[] } | undefined;
  try {
    const input = parseBeatInput(meta, parse(args.visual, 'visual'), args.narration); // pack-literal-ok (argument name)
    final = input.final;
    // The arc owns the shape: the formalization slot shows the equation, the moment cap holds.
    const moment = { ...input.moment, ...arcMoment(request.context.session.arc, meta.phase, args.idx, final, input.moment) };
    compiled = compileMoment(meta, moment, args.idx, final, sceneOf(canvas));
    // Under an arc the first moment may not draw the task's answer (before speech: the worker repairs it; later moments are not truncated).
    const visible = request.context.session.arc && args.idx === 0 ? visibleAnswer(meta.check, compiled.planned) : null;
    if (visible) throw new SenderError(visible);
    // Keyframes on point: the equation reveal moves to the sentence that reads it out.
    compiled = { ...compiled, beat: splitKeyframes(compiled.beat, narrationSentences(compiled.beat.narration)) };
    if (final) {
      const done = finalizeLesson(request, meta, [...beats, compiled.beat], plannable(record));
      meta = done.meta;
      compiled = { beat: done.step.beats.at(-1)!, planned: compiled.planned };
      accepted = { step: done.step, evidence: done.evidence };
    }
  } catch (e) {
    if (e instanceof SenderError) throw e;
    throw new SenderError(validatorMessage(e));
  }

  const { narration, ...visual } = compiled.beat;
  let sentenceIdx = utteranceSentences(ctx, session.id, args.utteranceId).length;
  const first = sentenceIdx;
  for (const raw of narrationSentences(narration)) {
    const { display, speech } = prepareSentence(raw);
    addSentence(ctx, { sessionId: session.id, utteranceId: args.utteranceId, idx: sentenceIdx++, display, speech });
  }
  const next = writeCanvas(ctx, ctx.db.canvasState.sessionId.find(session.id)!, compiled.planned);
  ctx.db.beat.insert({
    id: 0n,
    sessionId: session.id,
    utteranceId: args.utteranceId,
    idx: args.idx,
    visual: JSON.stringify(visual),
    narration,
    sentenceIdx: first,
    canvasVersion: next.version,
    createdAt: ctx.timestamp,
  });
  ctx.db.lessonPlan.utteranceId.update({
    ...plan,
    meta: JSON.stringify(meta),
    beats: JSON.stringify([...beats, compiled.beat]),
    scenes: JSON.stringify([...(JSON.parse(plan.scenes) as CanvasState[]), compiled.planned]),
    version: next.version,
    final,
  });
  if (accepted) saveRecord(ctx, session.id, acceptStep(plannable(record), accepted.step, accepted.evidence));
}

/**
 * The utterance ended. `finished`: every sentence played (or dropped) after the tutor turn was
 * appended; `interrupted`: barge-in, newer reply or typed turn. A complete lesson whose sentences
 * all played counts as presented; anything else is an interrupted presentation, and the canvas
 * rolls back to the scene after the last beat the learner saw (voice: started playing; text: shown).
 */
export function onUtteranceEnd(ctx: Ctx, sessionId: bigint, utteranceId: bigint, how: 'finished' | 'interrupted'): void {
  if (utteranceId === 0n) return;
  const plan = ctx.db.lessonPlan.utteranceId.find(utteranceId);
  if (!plan) return;
  const session = ctx.db.session.id.find(sessionId);
  if (!session) return;
  const sentences = utteranceSentences(ctx, sessionId, utteranceId);
  const allPlayed = sentences.every(s => s.status === PLAYED);
  let record = loadRecord(ctx, session);
  if (plan.final && (how === 'finished' || allPlayed)) {
    record = presented(record);
  } else {
    if (plan.final) record = interruptLesson(record);
    const beats = [...ctx.db.beat.sessionId.filter(sessionId)].filter(b => b.utteranceId === utteranceId).sort((a, b) => a.idx - b.idx);
    // Last sentence the learner got: voice = started playing; text = read, plus the one on screen.
    let shown = -1;
    for (const s of sentences) if (s.status === PLAYED) shown = Math.max(shown, s.idx);
    if (!session.voice && sentences.some(s => s.idx === shown + 1 && s.status === READY)) shown++;
    let seen = 0;
    while (seen < beats.length && beats[seen]!.sentenceIdx <= shown) seen++;
    const scenes = JSON.parse(plan.scenes) as CanvasState[];
    const canvas = ctx.db.canvasState.sessionId.find(sessionId);
    if (canvas && canvas.version === plan.version && seen < beats.length) writeCanvas(ctx, canvas, scenes[seen]!);
  }
  ctx.db.lessonPlan.utteranceId.delete(utteranceId);
  saveRecord(ctx, sessionId, record);
}

// ------------------------------------------------------------------ learner input

/** A student turn became ready (voice or typed). Team TeachingSession.submitTranscript / respond. */
export function onStudentTurnReady(ctx: Ctx, turn: TurnRow, opts: { assessed?: boolean } = {}): void {
  if (opts.assessed) return;
  const session = ctx.db.session.id.find(turn.sessionId);
  if (!session) return;
  let record = loadRecord(ctx, session);
  const eventId = `turn-${turn.id}`;
  let help: 'another_way' | 'simpler' | 'explain' | 'repeat' | undefined = HELP[turn.intent];
  let first: string[] | undefined;
  try {
    // Push back on significant changes, let the learner decide on the next turn (arc lessons, spoken/typed turns).
    if (record.config.arc && !turn.intent) {
      const d = decideTurn(record, truncate(turn.text, 2000), eventId);
      record = d.record;
      if (d.handled) return saveRecord(ctx, session.id, record);
      if (d.help && record.step) [help, first] = [d.help, d.ack];
    }
    if (record.step && help) record = respond(record, eventId, { kind: 'help', request: help }, sceneOf(canvasRow(ctx, session.id))).record;
    else if (turn.intent === 'continue') return;
    else if (record.step && record.status === 'awaiting_response') {
      const r = respond(record, eventId, answerResponse(record.step.check, truncate(turn.text, 2000)), sceneOf(canvasRow(ctx, session.id)));
      record = r.record;
      const line = record.config.arc ? feedbackLine(r.evidence.outcome, truncate(turn.text, 200)) : null;
      if (line) first = [line];
    } else record = recordUtterance(record, eventId, turn.text);
    // Authored first line (spoken at once while the step is planned); the planner knows it was said.
    if (first?.length) {
      const said = first.join(' ');
      record = {
        ...record,
        reply: { turnId: eventId, lines: first, sayOnly: false },
        config: { ...record.config, context: [...record.config.context.slice(-11), { id: `${eventId}-said`, text: `The tutor already said: "${said}" Do not repeat it; go straight on.`, source: 'tutor' }] },
      };
    }
  } catch (e) {
    console.warn(`lesson: turn ${turn.idx} of session ${turn.sessionId} not recorded: ${validatorMessage(e)}`);
    return;
  }
  saveRecord(ctx, session.id, record);
}

/** Client: canvas manipulation, picture submission or choice. Recorded in learner_event (accepted or not). */
export function submitInteraction(
  ctx: Ctx,
  args: { sessionId: bigint; kind: string; payload: string },
  submitTurn: (ctx: Ctx, sessionId: bigint, text: string) => void
): void {
  const session = getActiveSession(ctx, args.sessionId);
  if (!(INTERACTION_KINDS as readonly string[]).includes(args.kind)) throw new SenderError(`unknown interaction ${args.kind}; use one of ${INTERACTION_KINDS.join(', ')}`);
  const payload = parse(args.payload || '{}', 'payload');
  const event = ctx.db.learnerEvent.insert({ id: 0n, sessionId: session.id, kind: args.kind, payload: args.payload, accepted: false, evidence: '', createdAt: ctx.timestamp });
  const done = (accepted: boolean, evidence: unknown) => ctx.db.learnerEvent.id.update({ ...event, accepted, evidence: JSON.stringify(evidence) });
  let record = loadRecord(ctx, session);
  if (!record.step || record.status !== 'awaiting_response' || activePlan(ctx, session.id)) {
    done(false, { error: 'The picture is not open for answers right now.' });
    return;
  }
  const canvas = canvasRow(ctx, session.id);
  const scene = sceneOf(canvas);

  if (args.kind === 'math_action' || args.kind === 'activity_action') {
    const r = args.kind === 'math_action' ? applyLearnerMathAction(scene, payload) : applyLearnerActivityAction(scene, payload);
    if (!r.ok) return void done(false, { error: r.error });
    writeCanvas(ctx, canvas, r.canvas);
    done(true, { observation: r.observation });
    return;
  }

  let response: LearnerResponse['response'];
  let text: string;
  if (args.kind === 'choice') {
    const optionId = (payload as { optionId?: unknown }).optionId;
    const check = record.step.check;
    const option = check?.kind === 'choice' ? check.options.find(o => o.id === optionId) : undefined;
    if (typeof optionId !== 'string' || !option) return void done(false, { error: 'No recognized option was selected.' });
    response = { kind: 'choice', optionId };
    text = `I choose: ${option.label}`;
  } else {
    response = { kind: 'interaction' };
    text = 'Here is my picture.';
  }
  let evidence: Evidence;
  try {
    ({ record, evidence } = respond(record, `event-${event.id}`, response, scene));
  } catch (e) {
    return void done(false, { error: validatorMessage(e) });
  }
  saveRecord(ctx, session.id, record);
  done(true, evidence);
  // The team's policy: a response always leads to the next teaching step -> a student turn the worker answers.
  submitTurn(ctx, session.id, text);
}

// ------------------------------------------------------------------ worker status + tutor requests

export function agentHeartbeat(ctx: Ctx, args: { model: string; provider: string; busySessions: number }): void {
  requireAgent(ctx);
  const row = { id: 0, model: truncate(args.model, 120), provider: truncate(args.provider, 60), busySessions: args.busySessions, lastSeen: ctx.timestamp };
  if (ctx.db.agentStatus.id.find(0)) ctx.db.agentStatus.id.update(row);
  else ctx.db.agentStatus.insert(row);
}

export const TUTOR_REQUEST_KINDS = ['shear_feedback'] as const;

export function requestTutor(ctx: Ctx, args: { sessionId: bigint; kind: string; payload: string }): void {
  const session = getActiveSession(ctx, args.sessionId);
  if (!(TUTOR_REQUEST_KINDS as readonly string[]).includes(args.kind)) throw new SenderError(`unknown tutor request ${args.kind}`);
  parse(args.payload, 'payload');
  const pending = [...ctx.db.tutorRequest.sessionId.filter(session.id)].filter(r => r.status === 'pending').length;
  if (pending >= 2) throw new SenderError('The tutor is busy. Retry shortly.');
  ctx.db.tutorRequest.insert({ id: 0n, sessionId: session.id, kind: args.kind, payload: args.payload, status: 'pending', createdAt: ctx.timestamp });
}

export function submitTutorResult(ctx: Ctx, args: { requestId: bigint; ok: boolean; result: string }): void {
  requireAgent(ctx);
  const req = ctx.db.tutorRequest.id.find(args.requestId);
  if (!req) throw new SenderError(`tutor request ${args.requestId} not found`);
  if (req.status !== 'pending') throw new SenderError(`tutor request ${args.requestId} is already ${req.status}`);
  if (args.ok) parse(args.result, 'result');
  ctx.db.tutorRequest.id.update({ ...req, status: args.ok ? 'done' : 'error' });
  ctx.db.tutorResult.insert({ requestId: req.id, sessionId: req.sessionId, ok: args.ok, result: truncate(args.result, JSON_MAX), createdAt: ctx.timestamp });
}
