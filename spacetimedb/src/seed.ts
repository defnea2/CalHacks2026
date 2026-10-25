// Demo seed memory for a real learner (scripts/seed-demo.mjs; docs/DEMO.md "Seed memory").
// Agent only (the index wrapper checks the `role` table). Writes notes the tutor sees exactly
// like notes extracted from earlier sessions, plus concept mastery and one past session summary.
//
// Seeded rows are marked without a schema change: their evidence and the summary hang off a
// reserved pseudo session id (SEED_SESSION_BASE + learnerId) that no real session can reach.
// Re-seeding replaces exactly those notes (and the seed summary); notes written by the tutor or
// by memory extraction are never touched. Mastery is an upsert per listed concept.
import { SenderError } from 'spacetimedb/server';
import { pack } from '../../shared/src/lesson/index';
import { conceptBelongsTo, isCategory } from '../../shared/src/lesson/api';
import { MEMORY_KINDS, MEMORY_OUTCOMES } from '../../shared/src/types';
import { type Ctx, ts } from './ctx';

/** Pseudo session ids >= 2^62 mark seeded memory (real session ids are auto-increment from 1). */
export const SEED_SESSION_BASE = 1n << 62n;
export const seedSessionId = (learnerId: bigint) => SEED_SESSION_BASE + learnerId;

export const SEED_LIMITS = { notes: 20, text: 300, quote: 200, mastery: 10, summary: 1000, nextFocus: 300, daysAgo: 365 } as const;
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
}
export interface SeedMemory {
  notes?: SeedNote[];
  mastery?: Array<{ concept: string; mastery: number }>;
  summary?: { summary: string; nextFocus?: string };
  /** How long ago the seeded "earlier session" was (default 2); live notes are newer. */
  daysAgo?: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Parses and validates the seed; throws SenderError listing every problem. */
export function parseSeed(json: string): Required<Pick<SeedMemory, 'notes' | 'mastery' | 'daysAgo'>> & Pick<SeedMemory, 'summary'> {
  let raw: SeedMemory;
  try {
    raw = JSON.parse(json) as SeedMemory;
  } catch {
    throw new SenderError('memory must be a JSON object');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SenderError('memory must be a JSON object');
  const errors: string[] = [];
  const notes = raw.notes ?? [];
  const mastery = raw.mastery ?? [];
  if (!Array.isArray(notes)) errors.push('notes must be an array');
  if (!Array.isArray(mastery)) errors.push('mastery must be an array');
  if (errors.length) throw new SenderError(errors.join('; '));
  if (notes.length > SEED_LIMITS.notes) errors.push(`at most ${SEED_LIMITS.notes} notes`);
  if (mastery.length > SEED_LIMITS.mastery) errors.push(`at most ${SEED_LIMITS.mastery} mastery entries`);

  const outNotes: SeedNote[] = [];
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
    outNotes.push({ kind, category, concept, text, outcome, confidence, quote });
  });

  const outMastery: Array<{ concept: string; mastery: number }> = [];
  const seen = new Set<string>();
  mastery.forEach((m, i) => {
    const at = `mastery[${i}]`;
    const concept = str(m?.concept);
    if (!pack.taxonomy.some(c => c.concepts.some(k => k.key === concept))) errors.push(`${at}: unknown concept "${concept}"`);
    if (seen.has(concept)) errors.push(`${at}: concept "${concept}" listed twice`);
    seen.add(concept);
    if (!Number.isInteger(m?.mastery) || m.mastery < 0 || m.mastery > 100) errors.push(`${at}: mastery must be an integer 0-100`);
    outMastery.push({ concept, mastery: m?.mastery });
  });

  let summary: SeedMemory['summary'];
  if (raw.summary !== undefined && raw.summary !== null) {
    const s = str(raw.summary?.summary);
    const nf = str(raw.summary?.nextFocus);
    if (!s || s.length > SEED_LIMITS.summary) errors.push(`summary.summary must be 1-${SEED_LIMITS.summary} characters`);
    if (nf.length > SEED_LIMITS.nextFocus) errors.push(`summary.nextFocus must be at most ${SEED_LIMITS.nextFocus} characters`);
    summary = { summary: s, nextFocus: nf };
  }
  const daysAgo = raw.daysAgo ?? 2;
  if (!Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo > SEED_LIMITS.daysAgo) errors.push(`daysAgo must be an integer 0-${SEED_LIMITS.daysAgo}`);

  if (errors.length) throw new SenderError(errors.join('; '));
  return { notes: outNotes, mastery: outMastery, summary, daysAgo };
}

/** Removes the learner's seeded notes (+ their evidence) and seed summary. Returns notes removed. */
export function clearSeededMemory(ctx: Ctx, learnerId: bigint): number {
  const marker = seedSessionId(learnerId);
  let removed = 0;
  for (const n of [...ctx.db.memoryNote.learnerId.filter(learnerId)]) {
    const evidence = [...ctx.db.noteEvidence.noteId.filter(n.id)];
    if (!evidence.some(e => e.sessionId === marker)) continue;
    for (const e of evidence) ctx.db.noteEvidence.id.delete(e.id);
    ctx.db.memoryNote.id.delete(n.id);
    removed++;
  }
  if (ctx.db.sessionSummary.sessionId.find(marker)) ctx.db.sessionSummary.sessionId.delete(marker);
  return removed;
}

/** Replaces the learner's seeded memory with `json` (see SeedMemory). Real learners only. */
export function seedMemory(ctx: Ctx, learnerId: bigint, json: string): void {
  const learner = ctx.db.learner.id.find(learnerId);
  if (!learner) throw new SenderError(`learner ${learnerId} not found`);
  if (learner.isSimulated) throw new SenderError('simulated learners get their memory from simStudents.ts');
  const seed = parseSeed(json);
  clearSeededMemory(ctx, learnerId);

  const marker = seedSessionId(learnerId);
  const past = ctx.timestamp.microsSinceUnixEpoch - BigInt(seed.daysAgo) * DAY_US;
  seed.notes.forEach((n, i) => {
    // Staggered by 1 µs so the prompt lists them in file order (newest first = first note).
    const at = ts(past - BigInt(i));
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
    ctx.db.noteEvidence.insert({ id: 0n, noteId: note.id, sessionId: marker, fromTurn: 0, toTurn: 0, quote: n.quote ?? '' });
  });

  for (const m of seed.mastery) {
    const category = pack.taxonomy.find(c => c.concepts.some(k => k.key === m.concept))!.key;
    const row = [...ctx.db.conceptState.byLearnerConcept.filter([learnerId, m.concept])][0];
    if (row) ctx.db.conceptState.id.update({ ...row, mastery: m.mastery, updatedAt: ctx.timestamp });
    else ctx.db.conceptState.insert({ id: 0n, learnerId, category, concept: m.concept, mastery: m.mastery, updatedAt: ctx.timestamp });
  }

  if (seed.summary) {
    ctx.db.sessionSummary.insert({
      sessionId: marker,
      learnerId,
      summary: seed.summary.summary,
      nextFocus: seed.summary.nextFocus ?? '',
      createdAt: ts(past),
    });
  }
}
