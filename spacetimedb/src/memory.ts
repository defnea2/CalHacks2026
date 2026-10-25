// MemoryExtractor: every N turns a background LLM call classifies the conversation window and
// stores internal notes about the learner (spec "Memory extraction").
import { SenderError } from 'spacetimedb/server';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { pack } from '../../shared/src/lesson/index';
import { conceptBelongsTo, isCategory } from '../../shared/src/lesson/api';
import { MEMORY_KINDS, MEMORY_OUTCOMES, type TurnStatus } from '../../shared/src/types';
import { type Ctx, type NoteRow, type PCtx, type TurnRow, dueIn, getSession, sessionTurns, truncate } from './ctx';
import { settings } from './env';
import { chatJson, ProviderError } from './providers';

const T_OPEN: TurnStatus = 'open';
const T_CLOSING: TurnStatus = 'closing';
const CONTEXT_TURNS = 2;
const NOTE_TEXT_MAX = 300;
const QUOTE_MAX = 200;
const ACTIONS = ['create', 'update', 'reinforce'] as const;

// ---------------------------------------------------------------- scheduling

function cursorOf(ctx: Ctx, sessionId: bigint): number {
  return ctx.db.extractionCursor.sessionId.find(sessionId)?.nextIdx ?? 0;
}

/** First idx not safe to process yet: the earliest student turn still collecting phrases. */
function processableEnd(ctx: Ctx, sessionId: bigint, turnCount: number): number {
  let end = turnCount;
  for (const t of ctx.db.turn.sessionId.filter(sessionId)) {
    if (t.role === 'student' && (t.status === T_OPEN || t.status === T_CLOSING) && t.idx < end) end = t.idx;
  }
  return end;
}

function pendingJob(ctx: Ctx, sessionId: bigint) {
  for (const j of ctx.db.extractionJob.iter()) if (j.sessionId === sessionId) return j;
  return undefined;
}

/** Called whenever a student or tutor turn is appended (turnCount already raised). */
export function onTurnAppended(ctx: Ctx, sessionId: bigint): void {
  const session = ctx.db.session.id.find(sessionId);
  if (!session) return;
  const from = cursorOf(ctx, sessionId);
  const to = processableEnd(ctx, sessionId, session.turnCount);
  if (to - from < settings.memoryEveryN(ctx)) return;
  if (pendingJob(ctx, sessionId)) return; // a run (or its retry) is queued; it advances the cursor first
  ctx.db.extractionJob.insert({
    scheduledId: 0n,
    scheduledAt: dueIn(ctx),
    sessionId,
    learnerId: session.learnerId,
    fromIdx: from,
    toIdx: to,
    attempt: 0,
  });
}

/** endSession: final extraction for leftover turns + session summary. */
export function scheduleSessionEnd(ctx: Ctx, sessionId: bigint): void {
  const session = getSession(ctx, sessionId);
  const from = cursorOf(ctx, sessionId);
  const to = session.turnCount;
  const job = pendingJob(ctx, sessionId);
  if (job && job.fromIdx === from) {
    if (job.toIdx < to) ctx.db.extractionJob.scheduledId.update({ ...job, toIdx: to });
  } else if (to > from) {
    ctx.db.extractionJob.insert({
      scheduledId: 0n,
      scheduledAt: dueIn(ctx),
      sessionId,
      learnerId: session.learnerId,
      fromIdx: from,
      toIdx: to,
      attempt: 0,
    });
  }
  ctx.db.summaryJob.insert({ scheduledId: 0n, scheduledAt: dueIn(ctx), sessionId, learnerId: session.learnerId, attempt: 0 });
}

// ---------------------------------------------------------------- extraction

interface ExtractionItem {
  action: (typeof ACTIONS)[number];
  noteId: number;
  kind: string;
  category: string;
  concept: string;
  text: string;
  outcome: string;
  confidence: number;
  evidence: { fromTurn: number; toTurn: number; quote: string };
}
interface MasteryChange {
  concept: string;
  mastery: number;
  confidence: number;
}

const conceptKeys = () => pack.taxonomy.flatMap(c => c.concepts.map(k => k.key));

/** Strict JSON schema mode needs every property listed as required. */
const ITEM_FIELDS = Object.keys({
  action: 1, noteId: 1, kind: 1, category: 1, concept: 1, text: 1, outcome: 1, confidence: 1, evidence: 1,
} satisfies Record<keyof ExtractionItem, 1>);

function extractionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'mastery'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ITEM_FIELDS,
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            noteId: { type: 'integer', description: 'Existing note id for update/reinforce, 0 for create.' },
            kind: { type: 'string', enum: [...MEMORY_KINDS] },
            category: { type: 'string', enum: pack.taxonomy.map(c => c.key) },
            concept: { type: 'string', enum: ['', ...conceptKeys()], description: "'' if not specific." },
            text: { type: 'string', description: 'One short sentence about the learner.' },
            outcome: { type: 'string', enum: [...MEMORY_OUTCOMES] },
            confidence: { type: 'number', description: '0..1' },
            evidence: {
              type: 'object',
              additionalProperties: false,
              required: ['fromTurn', 'toTurn', 'quote'],
              properties: {
                fromTurn: { type: 'integer' },
                toTurn: { type: 'integer' },
                quote: { type: 'string', description: 'Short exact quote from the turns.' },
              },
            },
          },
        },
      },
      mastery: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['concept', 'mastery', 'confidence'],
          properties: {
            concept: { type: 'string', enum: conceptKeys() },
            mastery: { type: 'integer', description: 'New mastery estimate 0..100.' },
            confidence: { type: 'number' },
          },
        },
      },
    },
  };
}

function categoryOfConcept(concept: string): string | undefined {
  return pack.taxonomy.find(c => c.concepts.some(k => k.key === concept))?.key;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Drops invalid / low-confidence items; turns duplicate creates into reinforce. */
export function validateItems(
  raw: unknown,
  notes: NoteRow[],
  range: { fromIdx: number; toIdx: number }
): Array<ExtractionItem & { note?: NoteRow }> {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: Array<ExtractionItem & { note?: NoteRow }> = [];
  for (const it of items as Partial<ExtractionItem>[]) {
    if (!it || typeof it !== 'object') continue;
    if (!ACTIONS.includes(it.action as never)) continue;
    if (!MEMORY_KINDS.includes(it.kind as never)) continue;
    if (typeof it.category !== 'string' || !isCategory(pack, it.category)) continue;
    const concept = typeof it.concept === 'string' ? it.concept : '';
    if (concept && !conceptBelongsTo(pack, it.category, concept)) continue;
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    if (!text) continue;
    if (typeof it.confidence !== 'number' || !(it.confidence >= MODULE_DEFAULTS.MEMORY_MIN_CONFIDENCE)) continue;
    const outcome = MEMORY_OUTCOMES.includes(it.outcome as never) ? (it.outcome as string) : 'unknown';
    const ev = it.evidence ?? { fromTurn: range.fromIdx, toTurn: range.toIdx - 1, quote: '' };
    const clampTurn = (n: unknown) => Math.min(range.toIdx - 1, Math.max(range.fromIdx, Number.isInteger(n) ? (n as number) : range.fromIdx));
    const item: ExtractionItem & { note?: NoteRow } = {
      action: it.action!,
      noteId: Number(it.noteId ?? 0),
      kind: it.kind!,
      category: it.category,
      concept,
      text: truncate(text, NOTE_TEXT_MAX),
      outcome,
      confidence: Math.min(1, it.confidence),
      evidence: {
        fromTurn: clampTurn(ev.fromTurn),
        toTurn: Math.max(clampTurn(ev.fromTurn), clampTurn(ev.toTurn)),
        quote: truncate(typeof ev.quote === 'string' ? ev.quote : '', QUOTE_MAX),
      },
    };
    if (item.action !== 'create') {
      const note = notes.find(n => Number(n.id) === item.noteId);
      if (!note) item.action = 'create';
      else item.note = note;
    }
    if (item.action === 'create') {
      // Dedupe: same idea already stored -> reinforce it instead.
      const dup = notes.find(
        n => n.kind === item.kind && n.category === item.category && n.concept === item.concept && norm(n.text) === norm(item.text)
      );
      if (dup) {
        item.action = 'reinforce';
        item.note = dup;
      }
    }
    out.push(item);
  }
  return out;
}

function validateMastery(raw: unknown): MasteryChange[] {
  const list = (raw as { mastery?: unknown })?.mastery;
  if (!Array.isArray(list)) return [];
  const out: MasteryChange[] = [];
  for (const m of list as Partial<MasteryChange>[]) {
    if (!m || typeof m.concept !== 'string' || !categoryOfConcept(m.concept)) continue;
    if (typeof m.mastery !== 'number' || !Number.isFinite(m.mastery)) continue;
    if (typeof m.confidence !== 'number' || !(m.confidence >= MODULE_DEFAULTS.MEMORY_MIN_CONFIDENCE)) continue;
    out.push({ concept: m.concept, mastery: Math.round(Math.min(100, Math.max(0, m.mastery))), confidence: m.confidence });
  }
  return out;
}

function learnerNotes(ctx: Ctx, learnerId: bigint): NoteRow[] {
  return [...ctx.db.memoryNote.learnerId.filter(learnerId)].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function formatTurns(turns: TurnRow[], fromIdx: number): string {
  return turns
    .filter(t => t.text.trim())
    .map(t => `[${t.idx}]${t.idx < fromIdx ? ' (context)' : ''} ${t.role}${t.interrupted ? ' (interrupted)' : ''}: ${t.text}`)
    .join('\n');
}

function scheduleRetry(ctx: Ctx, job: ExtractionJobRow): void {
  const delays = MODULE_DEFAULTS.EXTRACTION_RETRY_S;
  if (job.attempt >= delays.length) return; // give up; the next appended turns schedule a fresh window
  ctx.db.extractionJob.insert({ ...job, scheduledId: 0n, scheduledAt: dueIn(ctx, delays[job.attempt]!), attempt: job.attempt + 1 });
}

type ExtractionJobRow = {
  scheduledId: bigint;
  scheduledAt: ReturnType<typeof dueIn>;
  sessionId: bigint;
  learnerId: bigint;
  fromIdx: number;
  toIdx: number;
  attempt: number;
};

export function extractMemory(ctx: PCtx, job: ExtractionJobRow): void {
  const input = ctx.withTx(tx => {
    if (cursorOf(tx, job.sessionId) !== job.fromIdx) return null; // another run handled it
    const turns = sessionTurns(tx, job.sessionId).filter(t => t.idx >= job.fromIdx - CONTEXT_TURNS && t.idx < job.toIdx);
    return { turns, notes: learnerNotes(tx, job.learnerId) };
  });
  if (!input) return;

  const inRange = input.turns.filter(t => t.idx >= job.fromIdx && t.text.trim());
  let raw: unknown = { items: [], mastery: [] };
  if (inRange.length > 0) {
    const system = [
      pack.prompts.extraction,
      '',
      'Categories and concepts:',
      ...pack.taxonomy.map(c => `- ${c.key}: ${c.concepts.map(k => k.key).join(', ')}`),
    ].join('\n');
    const user = [
      'Existing notes (id, kind, category, concept, outcome, text):',
      input.notes.length
        ? input.notes.map(n => `#${n.id} ${n.kind} ${n.category} ${n.concept || '-'} ${n.outcome}: ${n.text}`).join('\n')
        : '(none)',
      '',
      `Conversation window, turns ${job.fromIdx}..${job.toIdx - 1} (earlier turns are context only):`,
      formatTurns(input.turns, job.fromIdx),
    ].join('\n');
    try {
      raw = chatJson(ctx, { system, user, schemaName: 'memory_extraction', schema: extractionSchema() });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      console.warn(`extractMemory session ${job.sessionId} [${job.fromIdx},${job.toIdx}) attempt ${job.attempt}: ${e.message}`);
      ctx.withTx(tx => {
        if (cursorOf(tx, job.sessionId) === job.fromIdx) scheduleRetry(tx, job);
      });
      return;
    }
  }

  ctx.withTx(tx => {
    if (cursorOf(tx, job.sessionId) !== job.fromIdx) return; // raced: someone else wrote this window
    applyExtraction(tx, job, raw);
  });
}

/** Writes notes, evidence, mastery and advances the cursor (caller holds one transaction). */
export function applyExtraction(ctx: Ctx, job: { sessionId: bigint; learnerId: bigint; fromIdx: number; toIdx: number }, raw: unknown): void {
  const notes = learnerNotes(ctx, job.learnerId);
  for (const item of validateItems(raw, notes, job)) {
    let noteId: bigint;
    if (item.action === 'create') {
      noteId = ctx.db.memoryNote.insert({
        id: 0n,
        learnerId: job.learnerId,
        kind: item.kind,
        category: item.category,
        concept: item.concept,
        text: item.text,
        outcome: item.outcome,
        confidence: item.confidence,
        reinforced: 0,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      }).id;
      notes.push(ctx.db.memoryNote.id.find(noteId)!);
    } else {
      const note = ctx.db.memoryNote.id.find(item.note!.id)!;
      const updated =
        item.action === 'update'
          ? { ...note, text: item.text, outcome: item.outcome, concept: item.concept || note.concept, confidence: Math.max(note.confidence, item.confidence) }
          : {
              ...note,
              reinforced: note.reinforced + 1,
              // A later window may settle an unknown outcome.
              outcome: note.outcome === 'unknown' ? item.outcome : note.outcome,
              confidence: Math.max(note.confidence, item.confidence),
            };
      ctx.db.memoryNote.id.update({ ...updated, updatedAt: ctx.timestamp });
      noteId = note.id;
    }
    ctx.db.noteEvidence.insert({
      id: 0n,
      noteId,
      sessionId: job.sessionId,
      fromTurn: item.evidence.fromTurn,
      toTurn: item.evidence.toTurn,
      quote: item.evidence.quote,
    });
  }
  for (const m of validateMastery(raw)) setMastery(ctx, job.learnerId, m.concept, m.mastery);

  const cursor = ctx.db.extractionCursor.sessionId.find(job.sessionId);
  if (cursor) ctx.db.extractionCursor.sessionId.update({ ...cursor, nextIdx: job.toIdx });
  else ctx.db.extractionCursor.insert({ sessionId: job.sessionId, nextIdx: job.toIdx });
}

function setMastery(ctx: Ctx, learnerId: bigint, concept: string, mastery: number): void {
  const category = categoryOfConcept(concept)!;
  for (const row of ctx.db.conceptState.byLearnerConcept.filter([learnerId, concept])) {
    ctx.db.conceptState.id.update({ ...row, mastery, updatedAt: ctx.timestamp });
    return;
  }
  ctx.db.conceptState.insert({ id: 0n, learnerId, category, concept, mastery, updatedAt: ctx.timestamp });
}

// ---------------------------------------------------------------- summary

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'nextFocus'],
  properties: { summary: { type: 'string' }, nextFocus: { type: 'string' } },
};

export function summarizeSession(ctx: PCtx, job: { scheduledId: bigint; scheduledAt: ReturnType<typeof dueIn>; sessionId: bigint; learnerId: bigint; attempt: number }): void {
  const input = ctx.withTx(tx => {
    const session = tx.db.session.id.find(job.sessionId);
    if (!session) return null;
    return { session, turns: sessionTurns(tx, job.sessionId) };
  });
  if (!input) return;
  const spoken = input.turns.filter(t => t.text.trim());
  let result = { summary: 'No conversation in this session.', nextFocus: '' };
  if (spoken.length > 0) {
    const topic = [input.session.category, input.session.concept].filter(Boolean).join(' / ') || 'not set';
    const user = `Original task: ${input.session.taskText || '(none)'}\nTopic: ${topic}\nFinal phase: ${input.session.phase}\n\nConversation:\n${formatTurns(spoken, 0)}`;
    try {
      const raw = chatJson(ctx, { system: pack.prompts.summary, user, schemaName: 'session_summary', schema: SUMMARY_SCHEMA, maxTokens: 400 }) as {
        summary?: unknown;
        nextFocus?: unknown;
      };
      result = {
        summary: truncate(typeof raw.summary === 'string' ? raw.summary.trim() : '', 1000),
        nextFocus: truncate(typeof raw.nextFocus === 'string' ? raw.nextFocus.trim() : '', 300),
      };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      console.warn(`summarizeSession ${job.sessionId} attempt ${job.attempt}: ${e.message}`);
      ctx.withTx(tx => {
        const delays = MODULE_DEFAULTS.EXTRACTION_RETRY_S;
        if (job.attempt < delays.length) {
          tx.db.summaryJob.insert({ ...job, scheduledId: 0n, scheduledAt: dueIn(tx, delays[job.attempt]!), attempt: job.attempt + 1 });
        }
      });
      return;
    }
  }
  ctx.withTx(tx => {
    const row = { sessionId: job.sessionId, learnerId: job.learnerId, summary: result.summary, nextFocus: result.nextFocus, createdAt: tx.timestamp };
    if (tx.db.sessionSummary.sessionId.find(job.sessionId)) tx.db.sessionSummary.sessionId.update(row);
    else tx.db.sessionSummary.insert(row);
  });
}

// ---------------------------------------------------------------- remember tool

export function remember(
  ctx: Ctx,
  args: { sessionId: bigint; kind: string; category: string; concept: string; text: string; outcome: string }
): void {
  const session = getSession(ctx, args.sessionId);
  if (!MEMORY_KINDS.includes(args.kind as never)) throw new SenderError(`unknown kind ${args.kind}; use one of ${MEMORY_KINDS.join(', ')}`);
  if (!isCategory(pack, args.category)) throw new SenderError(`unknown category ${args.category}`);
  if (args.concept && !conceptBelongsTo(pack, args.category, args.concept)) {
    throw new SenderError(`concept ${args.concept} does not belong to ${args.category}`);
  }
  const outcome = args.outcome || 'unknown';
  if (!MEMORY_OUTCOMES.includes(outcome as never)) throw new SenderError(`unknown outcome ${args.outcome}`);
  const text = args.text.trim();
  if (!text) throw new SenderError('empty note');
  const notes = learnerNotes(ctx, session.learnerId);
  const dup = notes.find(n => n.kind === args.kind && n.category === args.category && n.concept === args.concept && norm(n.text) === norm(text));
  let noteId: bigint;
  if (dup) {
    ctx.db.memoryNote.id.update({
      ...dup,
      reinforced: dup.reinforced + 1,
      outcome: dup.outcome === 'unknown' ? outcome : dup.outcome,
      updatedAt: ctx.timestamp,
    });
    noteId = dup.id;
  } else {
    noteId = ctx.db.memoryNote.insert({
      id: 0n,
      learnerId: session.learnerId,
      kind: args.kind,
      category: args.category,
      concept: args.concept,
      text: truncate(text, NOTE_TEXT_MAX),
      outcome,
      confidence: 1,
      reinforced: 0,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    }).id;
  }
  const last = Math.max(0, session.turnCount - 1);
  ctx.db.noteEvidence.insert({ id: 0n, noteId, sessionId: session.id, fromTurn: last, toTurn: last, quote: '' });
}
