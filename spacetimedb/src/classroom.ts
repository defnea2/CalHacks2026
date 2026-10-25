// Classroom (night/classroom-core; docs/CONTRACT-night.md section 2, docs/CLASSROOM.md):
// teachers, presence, class sessions, the simulation of students and the teacher dashboard.
import { SenderError } from 'spacetimedb/server';
import { CLASSROOM_DEFAULTS as C } from '../../shared/src/config';
import { SIM_STUDENTS, type SimMemoryNote } from '../../shared/src/classroom/simStudents';
import { repairClusters, sizeRuleText, type Cluster, type ClusterStudent } from '../../shared/src/classroom/clusters';
import { pack } from '../../shared/src/lesson/index';
import { getPhase } from '../../shared/src/lesson/api';
import type { TurnState, TurnStatus } from '../../shared/src/types';
import { AnthropicError, callAnthropicJson } from './anthropic';
import { appendTextTurn } from './classroom_text';
import { isImageMime } from './classroom_context';
import { type Ctx, type PCtx, type SessionRow, type TurnRow, dueIn, onSessionUpdated, parseJson, sessionTurns, truncate, ts, updateSession } from './ctx';
import { settings } from './env';
import { describeBoard } from './lesson';
import { startConversation } from './opening';
import { ProviderError } from './providers';
import { endSession, startSession } from './sessions';

export const PRESENCE = ['offline', 'waiting', 'in_session'] as const;
export type PresenceStatus = (typeof PRESENCE)[number];
const OFFLINE: PresenceStatus = 'offline';
const WAITING: PresenceStatus = 'waiting';
const IN_SESSION: PresenceStatus = 'in_session';
const LISTENING: TurnState = 'listening';
const LIVE_STUDENT: readonly TurnStatus[] = ['open', 'closing', 'ready'];
const SIM_SOURCE = 'sim';

type ClassRow = NonNullable<ReturnType<Ctx['db']['classSession']['id']['find']>>;
type LearnerRow = NonNullable<ReturnType<Ctx['db']['learner']['id']['find']>>;

const micros = (s: number) => BigInt(Math.round(s * 1_000_000));
const connHex = (ctx: Ctx) => ctx.connectionId?.toHexString() ?? '';

// ================================================================ seed profiles

/** Loads/updates the 20 simulation profiles (init + connect; cheap when unchanged). */
export function ensureSimProfiles(ctx: Ctx): void {
  for (const s of SIM_STUDENTS) {
    const row = {
      rank: s.rank,
      name: s.name,
      age: s.age,
      grade: s.grade,
      style: s.style,
      persona: s.persona,
      misconceptions: JSON.stringify(s.misconceptions),
      memory: JSON.stringify(s.memory),
    };
    const cur = ctx.db.simProfile.rank.find(s.rank);
    if (!cur) ctx.db.simProfile.insert(row);
    else if (JSON.stringify(cur) !== JSON.stringify(row)) ctx.db.simProfile.rank.update(row);
  }
}

// ================================================================ teachers & presence

export function createTeacher(ctx: Ctx, name: string) {
  const n = name.trim();
  if (!n || n.length > 60) throw new SenderError('name must be 1-60 characters');
  return ctx.db.teacher.insert({ id: 0n, name: n, createdAt: ctx.timestamp });
}

function writePresence(ctx: Ctx, learnerId: bigint, status: PresenceStatus, connectionId?: string): void {
  const cur = ctx.db.presence.learnerId.find(learnerId);
  const row = { learnerId, status, connectionId: connectionId ?? cur?.connectionId ?? '', updatedAt: ctx.timestamp };
  if (cur) ctx.db.presence.learnerId.update(row);
  else ctx.db.presence.insert(row);
}

export function setPresence(ctx: Ctx, learnerId: bigint, status: string): void {
  if (!PRESENCE.includes(status as PresenceStatus)) throw new SenderError(`status must be one of ${PRESENCE.join(', ')}`);
  if (!ctx.db.learner.id.find(learnerId)) throw new SenderError(`learner ${learnerId} not found`);
  writePresence(ctx, learnerId, status as PresenceStatus, connHex(ctx));
}

/** clientDisconnected: that connection's (real) learners go offline. */
export function onDisconnect(ctx: Ctx): void {
  const hex = connHex(ctx);
  if (!hex) return;
  for (const p of [...ctx.db.presence.connectionId.filter(hex)]) {
    if (ctx.db.learner.id.find(p.learnerId)?.isSimulated) continue;
    if (p.status !== OFFLINE) ctx.db.presence.learnerId.update({ ...p, status: OFFLINE, updatedAt: ctx.timestamp });
  }
}

// ================================================================ class sessions

export interface StartClassArgs {
  teacherId: bigint;
  goals: string;
  content: string;
  delivery: string;
  documentName: string;
  documentMime: string;
  documentText: string;
  documentData: Uint8Array;
  simulatedCount: number;
}

function validateDocument(a: StartClassArgs): void {
  const mime = a.documentMime.trim();
  if (!mime) return;
  if (isImageMime(mime)) {
    if (!a.documentData.length) throw new SenderError('image document without data');
    if (a.documentData.length > C.DOCUMENT_MAX_BYTES) throw new SenderError(`document too large (max ${C.DOCUMENT_MAX_BYTES} bytes)`);
  } else if (/^text\/(markdown|plain|x-markdown)$/.test(mime)) {
    if (a.documentText.length > C.DOCUMENT_TEXT_MAX) throw new SenderError(`document text too long (max ${C.DOCUMENT_TEXT_MAX} chars)`);
  } else throw new SenderError('document must be an image (jpeg, png, webp, gif) or Markdown/plain text');
}

export function startClassSession(ctx: Ctx, a: StartClassArgs): ClassRow {
  if (!ctx.db.teacher.id.find(a.teacherId)) throw new SenderError(`teacher ${a.teacherId} not found`);
  if (a.simulatedCount > SIM_STUDENTS.length) throw new SenderError(`simulatedCount must be at most ${SIM_STUDENTS.length}`);
  validateDocument(a);
  for (const c of [...ctx.db.classSession.teacherId.filter(a.teacherId)]) if (c.active) endClassSession(ctx, c.id);

  const mime = a.documentMime.trim();
  const cls = ctx.db.classSession.insert({
    id: 0n,
    teacherId: a.teacherId,
    goals: a.goals.trim().slice(0, 4000),
    content: a.content.trim().slice(0, 4000),
    delivery: a.delivery.trim().slice(0, 4000),
    documentName: a.documentName.trim().slice(0, 200),
    documentMime: mime,
    documentText: isImageMime(mime) ? '' : a.documentText,
    active: true,
    simulation: a.simulatedCount > 0,
    simulatedCount: a.simulatedCount,
    startedAt: ctx.timestamp,
    endedAt: undefined,
  });
  if (isImageMime(mime)) ctx.db.classDocument.insert({ classSessionId: cls.id, data: a.documentData });

  // Every online real student joins (waiting or already in a session, ad-hoc or another class).
  for (const p of [...ctx.db.presence.iter()]) {
    if (p.status !== WAITING && p.status !== IN_SESSION) continue;
    const l = ctx.db.learner.id.find(p.learnerId);
    if (!l || l.isSimulated) continue;
    linkedSession(ctx, cls, l.id, true);
    writePresence(ctx, l.id, IN_SESSION);
  }

  // Simulation users: 1..n are reset and join in text mode; the others leave.
  for (const l of [...ctx.db.learner.iter()]) {
    if (l.isSimulated && (l.simRank < 1 || l.simRank > a.simulatedCount)) retireSimUser(ctx, l);
  }
  for (let rank = 1; rank <= a.simulatedCount; rank++) {
    const l = resetSimUser(ctx, rank);
    const s = linkedSession(ctx, cls, l.id, false);
    writePresence(ctx, l.id, IN_SESSION, '');
    startConversation(ctx, s.id); // the tutor speaks first; the student answers it
  }

  const due = ctx.timestamp.microsSinceUnixEpoch + micros(settings.dashboardIntervalS(ctx));
  ctx.db.dashboardState.insert({
    classSessionId: cls.id,
    impersonatingLearnerId: 0n,
    lastRunAt: undefined,
    nextDueAt: ts(due),
    running: false,
    runStartedAt: undefined,
    lastError: '',
  });
  scheduleDashboard(ctx, cls.id, due);
  return cls;
}

/** New session for the learner linked to the class (ends the learner's previous session). */
function linkedSession(ctx: Ctx, cls: ClassRow, learnerId: bigint, voice: boolean): SessionRow {
  const task = (cls.content || cls.goals).replace(/\s+/g, ' ').trim().slice(0, 300);
  const s = startSession(ctx, { learnerId, taskText: task });
  return updateSession(ctx, s, { classSessionId: cls.id, hasImage: isImageMime(cls.documentMime), ...voiceFlag(voice) });
}

/** session.voice (text mode, night/pipeline) when the column exists. */
function voiceFlag(_voice: boolean): Partial<SessionRow> {
  return {}; // TODO(text mode merge): { voice }
}

export function endClassSession(ctx: Ctx, classSessionId: bigint): void {
  const cls = ctx.db.classSession.id.find(classSessionId);
  if (!cls) throw new SenderError(`class session ${classSessionId} not found`);
  if (!cls.active) return;
  ctx.db.classSession.id.update({ ...cls, active: false, endedAt: ctx.timestamp });
  for (const s of linkedSessions(ctx, classSessionId)) {
    const l = ctx.db.learner.id.find(s.learnerId);
    endSession(ctx, s.id);
    clearSimJobs(ctx, s.id);
    if (!l) continue;
    const p = ctx.db.presence.learnerId.find(l.id);
    if (l.isSimulated) writePresence(ctx, l.id, OFFLINE);
    else if (p && p.status === IN_SESSION) writePresence(ctx, l.id, WAITING);
  }
  for (const j of [...ctx.db.dashboardJob.classSessionId.filter(classSessionId)]) ctx.db.dashboardJob.scheduledId.delete(j.scheduledId);
  const st = ctx.db.dashboardState.classSessionId.find(classSessionId);
  if (st) ctx.db.dashboardState.classSessionId.update({ ...st, impersonatingLearnerId: 0n });
}

/** Active sessions linked to the class session. */
export function linkedSessions(ctx: Ctx, classSessionId: bigint): SessionRow[] {
  return [...ctx.db.session.active.filter(true)].filter(s => s.classSessionId === classSessionId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ================================================================ simulation users

function profileNotes(rank: number): SimMemoryNote[] {
  return SIM_STUDENTS.find(s => s.rank === rank)?.memory ?? [];
}

/** Deletes a simulation user's learner row and everything that hangs off it, then recreates
 *  the learner from the seed with its seed memory notes. */
export function resetSimUser(ctx: Ctx, rank: number): LearnerRow {
  const p = ctx.db.simProfile.rank.find(rank);
  if (!p) throw new SenderError(`no simulation profile ${rank}`);
  for (const l of [...ctx.db.learner.iter()]) if (l.isSimulated && l.simRank === rank) deleteLearner(ctx, l.id);
  const learner = ctx.db.learner.insert({
    id: 0n,
    name: p.name,
    age: p.age,
    grade: p.grade,
    style: p.style,
    createdAt: ctx.timestamp,
    isSimulated: true,
    simRank: rank,
  });
  for (const n of profileNotes(rank)) {
    ctx.db.memoryNote.insert({
      id: 0n,
      learnerId: learner.id,
      kind: n.kind,
      category: n.category,
      concept: n.concept,
      text: n.text,
      outcome: n.outcome,
      confidence: 0.9,
      reinforced: 0,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
  return learner;
}

/** A simulation user not part of this run: session ended, offline. */
function retireSimUser(ctx: Ctx, l: LearnerRow): void {
  for (const s of [...ctx.db.session.learnerId.filter(l.id)]) {
    if (s.active) endSession(ctx, s.id);
    clearSimJobs(ctx, s.id);
  }
  const p = ctx.db.presence.learnerId.find(l.id);
  if (p && p.status !== OFFLINE) writePresence(ctx, l.id, OFFLINE);
}

function clearSimJobs(ctx: Ctx, sessionId: bigint): void {
  for (const j of [...ctx.db.simTurnJob.sessionId.filter(sessionId)]) ctx.db.simTurnJob.scheduledId.delete(j.scheduledId);
  if (ctx.db.simRunning.sessionId.find(sessionId)) ctx.db.simRunning.sessionId.delete(sessionId);
}

/** Tables keyed by sessionId that other branches add (text pipeline). Deleted when present. */
const EXTRA_SESSION_TABLES = ['canvasState', 'beat', 'lessonState', 'learnerEvent', 'tutorRequest', 'tutorResult'];

function deleteSessionData(ctx: Ctx, sessionId: bigint): void {
  const db = ctx.db;
  for (const r of [...db.turn.sessionId.filter(sessionId)]) db.turn.id.delete(r.id);
  for (const r of [...db.phrase.sessionId.filter(sessionId)]) db.phrase.id.delete(r.id);
  for (const r of [...db.replySentence.sessionId.filter(sessionId)]) db.replySentence.id.delete(r.id);
  for (const r of [...db.boardItem.sessionId.filter(sessionId)]) {
    if (db.boardAnswer.boardItemId.find(r.id)) db.boardAnswer.boardItemId.delete(r.id);
    db.boardItem.id.delete(r.id);
  }
  for (const r of [...db.turnMetrics.sessionId.filter(sessionId)]) db.turnMetrics.id.delete(r.id);
  for (const r of [...db.audioIn.sessionId.filter(sessionId)]) db.audioIn.id.delete(r.id);
  if (db.sessionImage.sessionId.find(sessionId)) db.sessionImage.sessionId.delete(sessionId);
  if (db.extractionCursor.sessionId.find(sessionId)) db.extractionCursor.sessionId.delete(sessionId);
  if (db.sessionSummary.sessionId.find(sessionId)) db.sessionSummary.sessionId.delete(sessionId);
  for (const j of [...db.extractionJob.iter()]) if (j.sessionId === sessionId) db.extractionJob.scheduledId.delete(j.scheduledId);
  for (const j of [...db.summaryJob.iter()]) if (j.sessionId === sessionId) db.summaryJob.scheduledId.delete(j.scheduledId);
  for (const j of [...db.ttsJob.iter()]) if (j.sessionId === sessionId) db.ttsJob.scheduledId.delete(j.scheduledId);
  for (const j of [...db.sttJob.iter()]) if (j.sessionId === sessionId) db.sttJob.scheduledId.delete(j.scheduledId);
  clearSimJobs(ctx, sessionId);
  const anyDb = db as unknown as Record<string, { iter?: () => Iterable<Record<string, unknown>>; sessionId?: { delete?: (k: bigint) => void }; id?: { delete?: (k: bigint) => void } }>;
  for (const name of EXTRA_SESSION_TABLES) {
    const t = anyDb[name];
    if (!t?.iter) continue;
    for (const r of [...t.iter()]) {
      if (r.sessionId !== sessionId) continue;
      if (t.id?.delete && typeof r.id === 'bigint') t.id.delete(r.id);
      else t.sessionId?.delete?.(sessionId);
    }
  }
  db.session.id.delete(sessionId);
}

function deleteLearner(ctx: Ctx, learnerId: bigint): void {
  const db = ctx.db;
  for (const s of [...db.session.learnerId.filter(learnerId)]) deleteSessionData(ctx, s.id);
  for (const n of [...db.memoryNote.learnerId.filter(learnerId)]) {
    for (const e of [...db.noteEvidence.noteId.filter(n.id)]) db.noteEvidence.id.delete(e.id);
    db.memoryNote.id.delete(n.id);
  }
  for (const c of [...db.conceptState.learnerId.filter(learnerId)]) db.conceptState.id.delete(c.id);
  for (const s of [...db.sessionSummary.learnerId.filter(learnerId)]) db.sessionSummary.sessionId.delete(s.sessionId);
  if (db.presence.learnerId.find(learnerId)) db.presence.learnerId.delete(learnerId);
  db.learner.id.delete(learnerId);
}

// ================================================================ simulated student turns

function isSimSession(ctx: Ctx, s: SessionRow): boolean {
  if (!s.active || !s.classSessionId) return false;
  return !!ctx.db.learner.id.find(s.learnerId)?.isSimulated;
}

function studentTurnCount(ctx: Ctx, sessionId: bigint): number {
  let n = 0;
  for (const t of ctx.db.turn.sessionId.filter(sessionId)) if (t.role === 'student') n++;
  return n;
}

/** Why the simulated student should not write now ('' = it should). */
export function simBlocker(ctx: Ctx, s: SessionRow): string {
  if (!isSimSession(ctx, s)) return 'not a simulated session';
  const cls = ctx.db.classSession.id.find(s.classSessionId);
  if (!cls?.active) return 'class session ended';
  if (s.turnState !== LISTENING || s.currentUtteranceId !== 0n) return `tutor busy (${s.turnState})`;
  const turns = sessionTurns(ctx, s.id);
  if (!turns.some(t => t.role === 'tutor')) return 'tutor has not spoken yet';
  if (turns.some(t => t.role === 'student' && LIVE_STUDENT.includes(t.status as TurnStatus))) return 'a student turn is pending';
  if (studentTurnCount(ctx, s.id) >= settings.simMaxTurns(ctx)) return 'turn cap reached';
  return '';
}

/** Session hook: a simulated session went back to listening -> next student message after a
 *  human-like delay. */
function onSessionChange(ctx: Ctx, prev: SessionRow, next: SessionRow): void {
  if (!next.classSessionId || next.turnState !== LISTENING || prev.turnState === LISTENING) return;
  maybeScheduleSimTurn(ctx, next);
}
onSessionUpdated(onSessionChange);

export function maybeScheduleSimTurn(ctx: Ctx, s: SessionRow): boolean {
  if (simBlocker(ctx, s)) return false;
  if ([...ctx.db.simTurnJob.sessionId.filter(s.id)].length) return false;
  const delay = C.SIM_DELAY_MIN_S + ctx.random() * (C.SIM_DELAY_MAX_S - C.SIM_DELAY_MIN_S);
  ctx.db.simTurnJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx, delay), sessionId: s.id, turnCount: s.turnCount, attempt: 0 });
  return true;
}

type SimJob = { scheduledId: bigint; scheduledAt: ReturnType<typeof dueIn>; sessionId: bigint; turnCount: number; attempt: number };

export type Behaviour = keyof typeof C.SIM_BEHAVIOUR;
export const BEHAVIOUR_HINTS: Record<Behaviour, string> = {
  mistake: 'This time make ONE of your typical mistakes (one that fits what the tutor just asked) and believe your answer is right.',
  question: 'This time do not answer directly: ask the tutor one short question about something you do not understand, or say what confuses you.',
  unsure: 'This time give a hesitant, partial answer ("maybe ...?", "i think ..."), possibly right.',
  correct: 'This time try your honest best; you get it right if it is within reach for a child like you.',
};

export function pickBehaviour(r: number): Behaviour {
  let acc = 0;
  for (const [k, p] of Object.entries(C.SIM_BEHAVIOUR) as Array<[Behaviour, number]>) {
    acc += p;
    if (r < acc) return k;
  }
  return 'correct';
}

const SIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string', description: "The child's next chat message, nothing else." } },
};

interface SimInput {
  system: string;
  user: string;
  behaviour: Behaviour;
  name: string;
}

function lessonStateText(ctx: Ctx, sessionId: bigint): string {
  const t = (ctx.db as unknown as Record<string, { sessionId?: { find?: (k: bigint) => Record<string, unknown> | undefined } }>).lessonState;
  const row = t?.sessionId?.find?.(sessionId);
  if (!row) return '';
  return truncate(JSON.stringify({ stage: row.stage, awaitingResponse: row.awaitingResponse, checkPrompt: row.checkPrompt }), 400);
}

function canvasText(ctx: Ctx, sessionId: bigint, max: number): string {
  const t = (ctx.db as unknown as Record<string, { sessionId?: { find?: (k: bigint) => Record<string, unknown> | undefined } }>).canvasState;
  const row = t?.sessionId?.find?.(sessionId);
  return row && typeof row.scene === 'string' ? truncate(row.scene, max) : '';
}

function transcriptLines(turns: TurnRow[], you: string, tutor: string, max: number): string {
  return turns
    .filter(t => t.text.trim())
    .slice(-max)
    .map(t => `${t.role === 'tutor' ? tutor : you}: ${t.text.trim()}`)
    .join('\n');
}

function simInput(ctx: Ctx, s: SessionRow): SimInput | null {
  const l = ctx.db.learner.id.find(s.learnerId);
  const p = l ? ctx.db.simProfile.rank.find(l.simRank) : undefined;
  const cls = ctx.db.classSession.id.find(s.classSessionId);
  if (!l || !p || !cls) return null;
  const behaviour = pickBehaviour(ctx.random());
  const misconceptions = parseJson<string[]>(p.misconceptions, []);
  const system = [
    `You play ${p.name.split(' ')[0]}, a real ${p.age}-year-old child in grade ${p.grade}, in a one-on-one online maths lesson with an AI tutor during class. You write ONLY the child's next chat message.`,
    `Personality and how you write: ${p.persona}`,
    `How you like to learn: ${p.style}.`,
    `Your typical mistakes and wrong ideas: ${misconceptions.map(m => `- ${m}`).join(' ')}`,
    'Rules: write like a child of your age typing in a chat: usually 1-15 words, at most 30; simple words; no LaTeX, no markdown, no emojis. Respond to what the tutor said last (answer its question if it asked one). Never say you are an AI, a simulation or role-playing. Do not repeat the tutor. Stay in character even if the tutor is confusing.',
    `This turn: ${BEHAVIOUR_HINTS[behaviour]}`,
  ].join('\n');
  const turns = sessionTurns(ctx, s.id);
  const lesson = lessonStateText(ctx, s.id);
  const canvas = canvasText(ctx, s.id, 1500);
  const user = [
    `Class topic: ${cls.content || cls.goals || 'maths'}`,
    `What the tutor shows on the board: ${describeBoard(ctx, s.id)}`,
    canvas ? `Canvas (JSON): ${canvas}` : '',
    lesson ? `Lesson state: ${lesson}` : '',
    '',
    'Chat so far:',
    transcriptLines(turns, 'You', 'Tutor', C.SIM_RECENT_TURNS) || '(nothing yet)',
    '',
    'Write your next message.',
  ]
    .filter(x => x !== '')
    .join('\n');
  return { system, user, behaviour, name: p.name };
}

/** Scheduled (sim_turn_job): one simulated student message. */
export function simStudentTurn(ctx: PCtx, job: SimJob): void {
  const prep = ctx.withTx(tx => {
    const s = tx.db.session.id.find(job.sessionId);
    if (!s || s.turnCount !== job.turnCount) return null; // stale: something else happened
    if (simBlocker(tx, s)) return null;
    const staleBefore = tx.timestamp.microsSinceUnixEpoch - micros(C.SIM_RUNNING_STALE_S);
    let running = 0;
    for (const r of [...tx.db.simRunning.iter()]) {
      if (r.startedAt.microsSinceUnixEpoch < staleBefore) tx.db.simRunning.sessionId.delete(r.sessionId);
      else running++;
    }
    if (running >= C.SIM_MAX_CONCURRENT || tx.db.simRunning.sessionId.find(s.id)) {
      if (job.attempt < C.SIM_MAX_ATTEMPTS) {
        tx.db.simTurnJob.insert({ ...job, scheduledId: 0n, scheduledAt: dueIn(tx, C.SIM_BUSY_RETRY_S * (0.7 + 0.6 * tx.random())), attempt: job.attempt + 1 });
      }
      return null;
    }
    const input = simInput(tx, s);
    if (!input) return null;
    tx.db.simRunning.insert({ sessionId: s.id, startedAt: tx.timestamp });
    return input;
  });
  if (!prep) return;

  let message = '';
  const started = Date.now();
  try {
    const r = callAnthropicJson<{ message?: unknown }>(ctx, { system: prep.system, user: prep.user, schema: SIM_SCHEMA, effort: C.SIM_EFFORT, maxTokens: C.SIM_MAX_TOKENS });
    message = typeof r.value?.message === 'string' ? r.value.message.replace(/\s+/g, ' ').trim() : '';
    console.log(`simStudentTurn s${job.sessionId} ${prep.name} [${prep.behaviour}]: ${r.model} ${Date.now() - started} ms, in=${r.usage.inputTokens} out=${r.usage.outputTokens} "${truncate(message, 80)}"`);
  } catch (e) {
    if (!(e instanceof ProviderError)) {
      ctx.withTx(tx => tx.db.simRunning.sessionId.find(job.sessionId) && tx.db.simRunning.sessionId.delete(job.sessionId));
      throw e;
    }
    console.warn(`simStudentTurn s${job.sessionId} attempt ${job.attempt}: ${e.message}`);
    const retry = !(e instanceof AnthropicError && e.kind === 'refusal');
    ctx.withTx(tx => {
      if (tx.db.simRunning.sessionId.find(job.sessionId)) tx.db.simRunning.sessionId.delete(job.sessionId);
      if (retry && job.attempt < C.SIM_FAILURE_RETRIES) {
        tx.db.simTurnJob.insert({ ...job, scheduledId: 0n, scheduledAt: dueIn(tx, C.SIM_FAILURE_RETRY_S), attempt: job.attempt + 1 });
      }
    });
    return;
  }
  ctx.withTx(tx => {
    if (tx.db.simRunning.sessionId.find(job.sessionId)) tx.db.simRunning.sessionId.delete(job.sessionId);
    const s = tx.db.session.id.find(job.sessionId);
    if (!s || s.turnCount !== job.turnCount || simBlocker(tx, s)) return; // the session moved on meanwhile
    submitSimText(tx, s.id, truncate(message || 'hmm i dont know', 300));
  });
}

/** The internal text-turn path with source 'sim'. */
export function submitSimText(ctx: Ctx, sessionId: bigint, text: string): void {
  appendTextTurn(ctx, sessionId, text, '', SIM_SOURCE);
}

// ================================================================ dashboard

function scheduleDashboard(ctx: Ctx, classSessionId: bigint, atMicros: bigint): void {
  for (const j of [...ctx.db.dashboardJob.classSessionId.filter(classSessionId)]) ctx.db.dashboardJob.scheduledId.delete(j.scheduledId);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  ctx.db.dashboardJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx, Number(atMicros > now ? atMicros - now : 0n) / 1e6), classSessionId });
}

export function setImpersonation(ctx: Ctx, classSessionId: bigint, learnerId: bigint): void {
  const cls = ctx.db.classSession.id.find(classSessionId);
  if (!cls) throw new SenderError(`class session ${classSessionId} not found`);
  const st = ctx.db.dashboardState.classSessionId.find(classSessionId);
  if (!st) throw new SenderError(`class session ${classSessionId} has no dashboard`);
  if (learnerId !== 0n) {
    if (!cls.active) throw new SenderError('class session has ended');
    if (!linkedSessions(ctx, classSessionId).some(s => s.learnerId === learnerId)) {
      throw new SenderError(`learner ${learnerId} is not in class session ${classSessionId}`);
    }
    ctx.db.dashboardState.classSessionId.update({ ...st, impersonatingLearnerId: learnerId });
    return;
  }
  ctx.db.dashboardState.classSessionId.update({ ...st, impersonatingLearnerId: 0n });
  // Stopped: an overdue refresh (skipped while observing) runs now, else at its due time.
  if (cls.active && !st.running) {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const due = st.nextDueAt.microsSinceUnixEpoch;
    scheduleDashboard(ctx, classSessionId, due <= now ? now : due);
  }
}

export interface StudentSnapshot {
  learnerId: string;
  name: string;
  age: number;
  sessionId: string;
  phase: string;
  topic: string;
  turnState: string;
  text: string;
}

function describeNotes(ctx: Ctx, learnerId: bigint): string {
  const notes = [...ctx.db.memoryNote.learnerId.filter(learnerId)]
    .sort((a, b) => (a.updatedAt.microsSinceUnixEpoch < b.updatedAt.microsSinceUnixEpoch ? 1 : -1))
    .slice(0, 8);
  return notes.length ? notes.map(n => `  - ${n.kind} [${n.concept || n.category}]: ${n.text}${n.outcome !== 'unknown' ? ` (${n.outcome})` : ''}`).join('\n') : '  (none)';
}

/** Whole context of every active student of the class (input of the dashboard call). */
export function classSnapshot(ctx: Ctx, classSessionId: bigint): StudentSnapshot[] {
  const out: StudentSnapshot[] = [];
  for (const s of linkedSessions(ctx, classSessionId)) {
    const l = ctx.db.learner.id.find(s.learnerId);
    if (!l) continue;
    const phase = getPhase(pack, s.phase);
    const topic = [s.category, s.concept].filter(Boolean).join(' / ');
    const turns = sessionTurns(ctx, s.id);
    const lesson = lessonStateText(ctx, s.id);
    const canvas = canvasText(ctx, s.id, 800);
    const text = [
      `Student ${l.id} — ${l.name}, age ${l.age}, grade ${l.grade}. Style: ${l.style || '-'}`,
      `Phase: ${phase ? `${phase.id} (${phase.label})` : s.phase}. Topic: ${topic || 'not set'}. Tutor state: ${s.turnState}. Turns so far: ${turns.length}.`,
      lesson ? `Lesson state: ${lesson}` : '',
      `Board: ${truncate(describeBoard(ctx, s.id).replace(/\n/g, ' '), 900)}`,
      canvas ? `Canvas: ${canvas}` : '',
      'Memory notes:',
      describeNotes(ctx, l.id),
      'Recent conversation:',
      transcriptLines(turns, 'Student', 'Tutor', C.DASHBOARD_RECENT_TURNS) || '(nothing yet)',
    ]
      .filter(x => x !== '')
      .join('\n');
    out.push({ learnerId: String(l.id), name: l.name, age: l.age, sessionId: String(s.id), phase: s.phase, topic, turnState: s.turnState, text });
  }
  return out;
}

const DASHBOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classSummary', 'clusters'],
  properties: {
    classSummary: { type: 'string', description: '2-4 short sentences for the teacher.' },
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'learnerIds'],
        properties: {
          name: { type: 'string', description: '1-3 words.' },
          description: { type: 'string', description: 'One short sentence: where these students stand.' },
          learnerIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const DASHBOARD_SYSTEM = [
  'You support a teacher who supervises a class of children (ages 8-12). Each child learns maths one-on-one with an AI tutor at the same time; the teacher sees a dashboard.',
  'Return:',
  '- classSummary: 2-4 short, concrete sentences about the learning state of the whole class: what most are working on, how far they got, common difficulties or misconceptions, and who (by first name) needs the teacher now. No fluff.',
  '- clusters: group EVERY student into exactly one cluster by similarity of their learning state (same lesson phase, same problem or misconception, similar progress). name: 1-3 words (e.g. "Adding bottoms", "Ready to practise"). description: one short sentence on their shared status. learnerIds: the student ids exactly as given.',
  'Cluster sizes are strict; follow the size rule in the message.',
].join('\n');

function dashboardUser(cls: ClassRow, students: StudentSnapshot[]): string {
  return [
    `Teacher's learning goals: ${cls.goals || '-'}`,
    `Content to cover: ${cls.content || '-'}`,
    `Delivery instructions: ${cls.delivery || '-'}`,
    '',
    `Size rule: ${sizeRuleText(students.length)} Clusters of 4 are fine when four students are in the same situation.`,
    `Student ids: ${students.map(s => s.learnerId).join(', ')}`,
    '',
    ...students.map(s => `=== ${s.text}`),
  ].join('\n');
}

interface DashboardPrep {
  cls: ClassRow;
  students: StudentSnapshot[];
}

/** Takes the run (running marker) unless skipped. Returns the input or a skip reason. */
function beginDashboard(ctx: Ctx, classSessionId: bigint, scheduled: boolean): DashboardPrep | string {
  const cls = ctx.db.classSession.id.find(classSessionId);
  if (!cls) return 'class session not found';
  if (!cls.active) return 'class session ended';
  const st = ctx.db.dashboardState.classSessionId.find(classSessionId);
  if (!st) return 'no dashboard';
  // Scheduled run while observing: skipped and not rescheduled; it is overdue when observing stops.
  if (st.impersonatingLearnerId !== 0n) return 'impersonating';
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (st.running && st.runStartedAt && now - st.runStartedAt.microsSinceUnixEpoch < micros(C.DASHBOARD_RUNNING_STALE_S)) return 'already running';
  if (scheduled && st.nextDueAt.microsSinceUnixEpoch > now + 500_000n) return 'not due';
  ctx.db.dashboardState.classSessionId.update({ ...st, running: true, runStartedAt: ctx.timestamp });
  return { cls, students: classSnapshot(ctx, classSessionId) };
}

export interface DashboardResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  repaired?: boolean;
  repairs?: string[];
  clusters?: number;
}

/** refreshDashboard (button) and dashboard_job (every DASHBOARD_INTERVAL_S). */
export function refreshDashboard(ctx: PCtx, classSessionId: bigint, scheduled: boolean): DashboardResult {
  const prep = ctx.withTx(tx => beginDashboard(tx, classSessionId, scheduled));
  if (typeof prep === 'string') return { ok: false, skipped: prep };
  const { cls, students } = prep;
  let summary = '';
  let clusters: Cluster[] = [];
  let repairs: string[] = [];
  let valid = true;
  if (students.length === 0) {
    summary = 'No students are in this class session right now.';
  } else {
    const started = Date.now();
    try {
      const r = callAnthropicJson<{ classSummary?: unknown; clusters?: unknown }>(ctx, {
        system: DASHBOARD_SYSTEM,
        user: dashboardUser(cls, students),
        schema: DASHBOARD_SCHEMA,
        effort: C.DASHBOARD_EFFORT,
        maxTokens: C.DASHBOARD_MAX_TOKENS,
      });
      summary = typeof r.value?.classSummary === 'string' ? truncate(r.value.classSummary.trim(), 1500) : '';
      const raw = normalizeClusters(r.value?.clusters);
      const fixed = repairClusters(raw, students.map<ClusterStudent>(s => ({ id: s.learnerId, phase: s.phase, topic: s.topic })));
      clusters = fixed.clusters;
      repairs = fixed.repairs;
      valid = fixed.valid;
      console.log(
        `refreshDashboard c${classSessionId} ${students.length} students: ${r.model} ${Date.now() - started} ms, in=${r.usage.inputTokens} out=${r.usage.outputTokens}, clusters ${clusters.map(c => c.learnerIds.length).join('+')}${valid ? '' : ` (repaired: ${repairs.join('; ')})`}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`refreshDashboard c${classSessionId}: ${msg}`);
      ctx.withTx(tx => {
        const st = tx.db.dashboardState.classSessionId.find(classSessionId);
        if (!st) return;
        const due = tx.timestamp.microsSinceUnixEpoch + micros(C.DASHBOARD_RETRY_S);
        tx.db.dashboardState.classSessionId.update({ ...st, running: false, runStartedAt: undefined, nextDueAt: ts(due), lastError: truncate(msg, 300) });
        const c = tx.db.classSession.id.find(classSessionId);
        if (c?.active && st.impersonatingLearnerId === 0n) scheduleDashboard(tx, classSessionId, due);
      });
      if (!(e instanceof ProviderError)) throw e;
      return { ok: false, error: msg };
    }
  }
  ctx.withTx(tx => writeDashboard(tx, classSessionId, summary, clusters));
  return { ok: true, repaired: !valid, repairs, clusters: clusters.length };
}

function normalizeClusters(raw: unknown): Cluster[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map(c => ({
      name: truncate(typeof c.name === 'string' ? c.name.trim() : '', 40),
      description: truncate(typeof c.description === 'string' ? c.description.trim() : '', 240),
      learnerIds: Array.isArray(c.learnerIds) ? c.learnerIds.map(x => String(x).trim().replace(/^#/, '')) : [],
    }));
}

/** Atomically replaces summary + clusters and books the next run. */
export function writeDashboard(ctx: Ctx, classSessionId: bigint, summary: string, clusters: Cluster[]): void {
  const prev = ctx.db.classSummary.classSessionId.find(classSessionId);
  const row = { classSessionId, summary, updatedAt: ctx.timestamp, version: (prev?.version ?? 0) + 1 };
  if (prev) ctx.db.classSummary.classSessionId.update(row);
  else ctx.db.classSummary.insert(row);
  for (const c of [...ctx.db.studentCluster.classSessionId.filter(classSessionId)]) ctx.db.studentCluster.id.delete(c.id);
  clusters.forEach((c, position) =>
    ctx.db.studentCluster.insert({ id: 0n, classSessionId, position, name: c.name || 'Group', description: c.description, learnerIds: JSON.stringify(c.learnerIds) })
  );
  const st = ctx.db.dashboardState.classSessionId.find(classSessionId);
  if (!st) return;
  const due = ctx.timestamp.microsSinceUnixEpoch + micros(settings.dashboardIntervalS(ctx));
  ctx.db.dashboardState.classSessionId.update({ ...st, running: false, runStartedAt: undefined, lastRunAt: ctx.timestamp, nextDueAt: ts(due), lastError: '' });
  const cls = ctx.db.classSession.id.find(classSessionId);
  if (cls?.active) scheduleDashboard(ctx, classSessionId, due);
}
