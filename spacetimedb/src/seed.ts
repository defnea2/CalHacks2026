// Demo seed memory for a real learner (scripts/seed-demo.mjs; docs/DEMO.md "Seed memory").
// Agent only (the index wrapper checks the `role` table). Writes notes the tutor sees exactly
// like notes extracted from earlier sessions, plus concept mastery and past session summaries.
//
// Seeded rows are marked without a schema change: their evidence and the summaries hang off
// reserved pseudo session ids (seedSessionId) that no real session can reach. Re-seeding replaces
// exactly those notes (and the seed summaries); notes written by the tutor or by memory
// extraction are never touched. Mastery is an upsert per listed concept.
//
// The 20 simulated students get their seed through the same writeSeed (classroom.ts
// resetSimUser, data in shared/src/classroom/simStudents.ts); the seedMemory reducer refuses them.
import { SenderError } from 'spacetimedb/server';
import { pack } from '../../shared/src/lesson/index';
import { conceptBelongsTo, isCategory } from '../../shared/src/lesson/api';
import { MEMORY_KINDS, MEMORY_OUTCOMES } from '../../shared/src/types';
import { type Ctx, ts } from './ctx';

/** Pseudo session ids >= 2^62 mark seeded memory (real session ids are auto-increment from 1). */
export const SEED_SESSION_BASE = 1n << 62n;
/** Low bits of a pseudo session id hold the learner id; the seeded-session index sits above. */
const SEED_LEARNER_BITS = 40n;
const SEED_LEARNER_MASK = (1n << SEED_LEARNER_BITS) - 1n;
/** Pseudo session `index` of a learner's seed: BASE + index * 2^40 + learnerId (stays below
 *  2^63 for index < 2^22). Index 0 carries the note evidence and the first summary and is
 *  BASE + learnerId, as before multiple seeded sessions existed. */
export const seedSessionId = (learnerId: bigint, index = 0) => SEED_SESSION_BASE + (BigInt(index) << SEED_LEARNER_BITS) + learnerId;
/** The index seedSessionId encoded into a pseudo session id. */
export const seedSessionIndex = (sessionId: bigint) => Number((sessionId - SEED_SESSION_BASE) >> SEED_LEARNER_BITS);
/** True for every pseudo session id seedSessionId can produce for `learnerId`. */
export const isSeedSessionOf = (sessionId: bigint, learnerId: bigint) =>
  sessionId >= SEED_SESSION_BASE && ((sessionId - SEED_SESSION_BASE) & SEED_LEARNER_MASK) === learnerId;

export const SEED_LIMITS = { notes: 20, text: 300, quote: 200, mastery: 10, sessions: 5, task: 300, summary: 1000, nextFocus: 300, daysAgo: 365 } as const;
const DAY_US = 86_400_000_000n;

export interface SeedNote {
  kind: string;
  category: string;
  concept?: string;
  text: string;
  outcome?: string;
  confidence?: number;
  /** Short quote of the child, stored as note evidence. */
  quote?: string;
  /** Index of the seeded session (summary first, then history) the note and its evidence come
   *  from; default: the newest seeded session. */
  session?: number;
}
export interface SeedSession {
  summary: string;
  nextFocus?: string;
  /** Task text of that session (the profile shows "Task: ..."). */
  task?: string;
  /** Concept key of the session's topic (category follows from the taxonomy). */
  concept?: string;
  /** How long ago that session was (default: the seed's daysAgo). Distinct per seeded session. */
  daysAgo?: number;
}
export interface SeedMemory {
  notes?: SeedNote[];
  mastery?: Array<{ concept: string; mastery: number }>;
  /** The earlier session the tutor remembers, dated daysAgo. */
  summary?: { summary: string; nextFocus?: string; task?: string; concept?: string };
  /** More earlier sessions, each with its own daysAgo (the profile lists them newest first). */
  history?: SeedSession[];
  /** How long ago the notes (and `summary`) were written (default 2); live notes are newer. */
  daysAgo?: number;
}
/** A validated seed: `summary` (if any) first in `sessions`, then `history`. */
export interface ParsedSeed {
  notes: SeedNote[];
  mastery: Array<{ concept: string; mastery: number }>;
  sessions: Array<{ summary: string; nextFocus: string; daysAgo: number; task: string; category: string; concept: string }>;
  daysAgo: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const validDays = (d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= SEED_LIMITS.daysAgo;

/** Validates a seed object against the pack taxonomy, kinds, outcomes and limits. `errors` lists
 *  every problem (empty = valid); `seed` is the normalised seed. */
export function validateSeed(raw: unknown): { errors: string[]; seed: ParsedSeed } {
  const seed: ParsedSeed = { notes: [], mastery: [], sessions: [], daysAgo: 2 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['memory must be a JSON object'], seed };
  const r = raw as SeedMemory;
  const errors: string[] = [];
  const notes = r.notes ?? [];
  const mastery = r.mastery ?? [];
  const history = r.history ?? [];
  if (!Array.isArray(notes)) errors.push('notes must be an array');
  if (!Array.isArray(mastery)) errors.push('mastery must be an array');
  if (!Array.isArray(history)) errors.push('history must be an array');
  if (errors.length) return { errors, seed };
  if (notes.length > SEED_LIMITS.notes) errors.push(`at most ${SEED_LIMITS.notes} notes`);
  if (mastery.length > SEED_LIMITS.mastery) errors.push(`at most ${SEED_LIMITS.mastery} mastery entries`);

  notes.forEach((n, i) => {
    const at = `notes[${i}]`;
    if (!n || typeof n !== 'object') return void errors.push(`${at}: must be an object`);
    const kind = str(n.kind);
    const category = str(n.category);
    const concept = str(n.concept);
    const text = str(n.text);
    const outcome = str(n.outcome) || 'unknown';
    const quote = str(n.quote);
    const confidence = n.confidence ?? 0.9;
    if (!MEMORY_KINDS.includes(kind as never)) errors.push(`${at}: kind must be one of ${MEMORY_KINDS.join(', ')}`);
    if (!isCategory(pack, category)) errors.push(`${at}: unknown category "${category}"`);
    else if (concept && !conceptBelongsTo(pack, category, concept)) errors.push(`${at}: concept "${concept}" does not belong to ${category}`);
    if (!text || text.length > SEED_LIMITS.text) errors.push(`${at}: text must be 1-${SEED_LIMITS.text} characters`);
    if (!MEMORY_OUTCOMES.includes(outcome as never)) errors.push(`${at}: outcome must be one of ${MEMORY_OUTCOMES.join(', ')}`);
    if (quote.length > SEED_LIMITS.quote) errors.push(`${at}: quote must be at most ${SEED_LIMITS.quote} characters`);
    if (typeof confidence !== 'number' || !(confidence > 0 && confidence <= 1)) errors.push(`${at}: confidence must be in (0, 1]`);
    if (n.session !== undefined && !Number.isInteger(n.session)) errors.push(`${at}: session must be an index into summary + history`);
    seed.notes.push({ kind, category, concept, text, outcome, confidence, quote, session: n.session });
  });

  const seen = new Set<string>();
  mastery.forEach((m, i) => {
    const at = `mastery[${i}]`;
    const concept = str(m?.concept);
    if (!pack.taxonomy.some(c => c.concepts.some(k => k.key === concept))) errors.push(`${at}: unknown concept "${concept}"`);
    if (seen.has(concept)) errors.push(`${at}: concept "${concept}" listed twice`);
    seen.add(concept);
    if (!Number.isInteger(m?.mastery) || m.mastery < 0 || m.mastery > 100) errors.push(`${at}: mastery must be an integer 0-100`);
    seed.mastery.push({ concept, mastery: m?.mastery });
  });

  const daysAgo = r.daysAgo ?? 2;
  if (!validDays(daysAgo)) errors.push(`daysAgo must be an integer 0-${SEED_LIMITS.daysAgo}`);
  seed.daysAgo = daysAgo;

  const addSession = (s: unknown, at: string, days: unknown) => {
    const o = (s && typeof s === 'object' ? s : {}) as SeedSession;
    const summary = str(o.summary);
    const nextFocus = str(o.nextFocus);
    const task = str(o.task);
    const concept = str(o.concept);
    const category = pack.taxonomy.find(c => c.concepts.some(k => k.key === concept))?.key ?? '';
    if (concept && !category) errors.push(`${at}.concept: unknown concept "${concept}"`);
    if (task.length > SEED_LIMITS.task) errors.push(`${at}.task must be at most ${SEED_LIMITS.task} characters`);
    if (!summary || summary.length > SEED_LIMITS.summary) errors.push(`${at}.summary must be 1-${SEED_LIMITS.summary} characters`);
    if (nextFocus.length > SEED_LIMITS.nextFocus) errors.push(`${at}.nextFocus must be at most ${SEED_LIMITS.nextFocus} characters`);
    if (!validDays(days)) errors.push(`${at}.daysAgo must be an integer 0-${SEED_LIMITS.daysAgo}`);
    seed.sessions.push({ summary, nextFocus, daysAgo: days as number, task, category, concept });
  };
  if (r.summary !== undefined && r.summary !== null) addSession(r.summary, 'summary', daysAgo);
  history.forEach((h, i) => addSession(h, `history[${i}]`, (h as SeedSession | null)?.daysAgo ?? daysAgo));
  if (seed.sessions.length > SEED_LIMITS.sessions) errors.push(`at most ${SEED_LIMITS.sessions} seeded sessions (summary + history)`);
  const days = seed.sessions.map(s => s.daysAgo);
  if (new Set(days).size !== days.length) errors.push('each seeded session (summary + history) needs a different daysAgo');
  seed.notes.forEach((n, i) => {
    if (n.session !== undefined && Number.isInteger(n.session) && (n.session < 0 || n.session >= Math.max(1, seed.sessions.length)))
      errors.push(`notes[${i}]: session ${n.session} does not exist (${seed.sessions.length} seeded sessions)`);
  });

  return { errors, seed };
}

/** Parses and validates the seed JSON; throws SenderError listing every problem. */
export function parseSeed(json: string): ParsedSeed {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SenderError('memory must be a JSON object');
  }
  const { errors, seed } = validateSeed(raw);
  if (errors.length) throw new SenderError(errors.join('; '));
  return seed;
}

/** Removes the learner's seeded notes (+ their evidence) and seed summaries. Returns notes removed. */
export function clearSeededMemory(ctx: Ctx, learnerId: bigint): number {
  let removed = 0;
  for (const n of [...ctx.db.memoryNote.learnerId.filter(learnerId)]) {
    const evidence = [...ctx.db.noteEvidence.noteId.filter(n.id)];
    if (!evidence.some(e => isSeedSessionOf(e.sessionId, learnerId))) continue;
    for (const e of evidence) ctx.db.noteEvidence.id.delete(e.id);
    ctx.db.memoryNote.id.delete(n.id);
    removed++;
  }
  for (const s of [...ctx.db.sessionSummary.learnerId.filter(learnerId)]) {
    if (isSeedSessionOf(s.sessionId, learnerId)) ctx.db.sessionSummary.sessionId.delete(s.sessionId);
  }
  for (const s of [...ctx.db.seedSession.learnerId.filter(learnerId)]) ctx.db.seedSession.sessionId.delete(s.sessionId);
  return removed;
}

/** Index of the newest seeded session (smallest daysAgo); 0 when there are none. */
function newestSession(seed: ParsedSeed, concept = ''): number {
  let best = -1;
  seed.sessions.forEach((s, i) => {
    if (concept && s.concept !== concept) return;
    if (best < 0 || s.daysAgo < seed.sessions[best]!.daysAgo) best = i;
  });
  return best < 0 ? (concept ? newestSession(seed) : 0) : best;
}

/** Replaces the learner's seeded memory with a validated seed (no learner checks). Each seeded
 *  session i gets pseudo session id seedSessionId(learnerId, i): a seed_session row (task,
 *  topic, date) and its summary. Notes are dated with their session and carry their evidence
 *  quote on it; mastery is dated with the newest session of that concept (else the newest).
 *  Shared by the seedMemory reducer and classroom.ts resetSimUser. */
export function writeSeed(ctx: Ctx, learnerId: bigint, seed: ParsedSeed): void {
  clearSeededMemory(ctx, learnerId);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const dateOf = (i: number) => now - BigInt(seed.sessions[i]?.daysAgo ?? seed.daysAgo) * DAY_US;

  seed.sessions.forEach((s, i) => {
    const sessionId = seedSessionId(learnerId, i);
    const at = ts(dateOf(i));
    ctx.db.seedSession.insert({ sessionId, learnerId, taskText: s.task, category: s.category, concept: s.concept, startedAt: at });
    ctx.db.sessionSummary.insert({ sessionId, learnerId, summary: s.summary, nextFocus: s.nextFocus, createdAt: at });
  });

  const fallback = newestSession(seed);
  seed.notes.forEach((n, i) => {
    const session = n.session ?? fallback;
    // Staggered by 1 µs so the prompt lists them in file order (newest first = first note).
    const at = ts(dateOf(session) - BigInt(i));
    const note = ctx.db.memoryNote.insert({
      id: 0n,
      learnerId,
      kind: n.kind,
      category: n.category,
      concept: n.concept ?? '',
      text: n.text,
      outcome: n.outcome ?? 'unknown',
      confidence: n.confidence ?? 0.9,
      reinforced: 0,
      createdAt: at,
      updatedAt: at,
    });
    ctx.db.noteEvidence.insert({ id: 0n, noteId: note.id, sessionId: seedSessionId(learnerId, session), fromTurn: 0, toTurn: 0, quote: n.quote ?? '' });
  });

  for (const m of seed.mastery) {
    const category = pack.taxonomy.find(c => c.concepts.some(k => k.key === m.concept))!.key;
    const updatedAt = seed.sessions.length ? ts(dateOf(newestSession(seed, m.concept))) : ctx.timestamp;
    const row = [...ctx.db.conceptState.byLearnerConcept.filter([learnerId, m.concept])][0];
    if (row) ctx.db.conceptState.id.update({ ...row, mastery: m.mastery, updatedAt });
    else ctx.db.conceptState.insert({ id: 0n, learnerId, category, concept: m.concept, mastery: m.mastery, updatedAt });
  }
}

/** Replaces the learner's seeded memory with `json` (see SeedMemory). Real learners only. */
export function seedMemory(ctx: Ctx, learnerId: bigint, json: string): void {
  const learner = ctx.db.learner.id.find(learnerId);
  if (!learner) throw new SenderError(`learner ${learnerId} not found`);
  if (learner.isSimulated) throw new SenderError('simulated learners get their memory from simStudents.ts');
  writeSeed(ctx, learnerId, parseSeed(json));
}
