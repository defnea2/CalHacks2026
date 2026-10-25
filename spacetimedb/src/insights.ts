// Teacher-facing student profile (contract: shared/src/insights.ts). Long-term information
// only: memory notes with evidence, concept mastery, the last session summaries.
//
// Privacy: memory_note / note_evidence / concept_state / session_summary stay private tables
// (no subscription path). This procedure is their only client read path: the caller must own
// the teacher account (account_link) and the learner must be on that teacher's roster (added by
// the teacher or in one of the teacher's class sessions; auth.ts). When the module env
// INSIGHTS_KEY is set, the key must match as well (optional extra).
import type { Timestamp } from 'spacetimedb';
import {
  INSIGHT_EVIDENCE_PER_NOTE,
  INSIGHT_KIND_ORDER,
  INSIGHT_MAX_NOTES,
  INSIGHT_MAX_SUMMARIES,
  INSIGHT_QUOTE_MAX,
  type InsightNote,
  type LearnerInsightsResult,
} from '../../shared/src/insights';
import { MEMORY_OUTCOMES, type MemoryKind, type MemoryOutcome } from '../../shared/src/types';
import { type Ctx, type PCtx, truncate } from './ctx';
import { readEnv } from './env';
import { pack } from '../../shared/src/lesson/index';
import { SEED_SESSION_BASE, seedSessionIndex } from './seed';
import { TEACHER, isLinked, isTeacherOf } from './auth';
import { isAgent } from './ctx';

const ms = (t: Timestamp): number => Number(t.microsSinceUnixEpoch / 1000n);
/** Newest first. */
const desc = (a: Timestamp, b: Timestamp): number => Number(b.microsSinceUnixEpoch - a.microsSinceUnixEpoch > 0n) - Number(b.microsSinceUnixEpoch - a.microsSinceUnixEpoch < 0n);

/** Session id as shown to the client: 'seed-<n>' for the reserved seed pseudo sessions
 *  (seed.ts; n = 1, 2, ... per learner, never the raw pseudo id), else the decimal id. */
const sessionRef = (id: bigint): string => (id >= SEED_SESSION_BASE ? `seed-${seedSessionIndex(id) + 1}` : String(id));

function kindRank(kind: string): number {
  const i = INSIGHT_KIND_ORDER.indexOf(kind as MemoryKind);
  return i < 0 ? INSIGHT_KIND_ORDER.length : i;
}

/** Read-only; runs inside one transaction. */
export function readInsights(tx: Ctx, args: { learnerId: bigint; teacherId: bigint; key: string }): LearnerInsightsResult {
  const required = readEnv(tx, 'INSIGHTS_KEY');
  if (required !== undefined && args.key.trim() !== required) return { ok: false, error: 'locked' };
  if (!tx.db.teacher.id.find(args.teacherId)) return { ok: false, error: 'unknown_teacher' };
  const agent = isAgent(tx);
  if (!agent && !isLinked(tx, TEACHER, args.teacherId)) return { ok: false, error: 'not_your_teacher' };
  const l = tx.db.learner.id.find(args.learnerId);
  if (!l) return { ok: false, error: 'unknown_learner' };
  if (!agent && !isTeacherOf(tx, args.teacherId, l.id)) return { ok: false, error: 'not_your_student' };

  // Content-library title, else the pack taxonomy's (concepts without library content, e.g. regrouping).
  const conceptTitle = (key: string) =>
    key ? tx.db.concept.key.find(key)?.title || pack.taxonomy.flatMap(c => c.concepts).find(k => k.key === key)?.title || '' : '';
  const categoryTitle = (key: string) => (key ? tx.db.category.key.find(key)?.title || pack.taxonomy.find(c => c.key === key)?.title || '' : '');

  const notes: InsightNote[] = [...tx.db.memoryNote.learnerId.filter(l.id)]
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || desc(a.updatedAt, b.updatedAt) || (b.id > a.id ? 1 : -1))
    .slice(0, INSIGHT_MAX_NOTES)
    .map(n => {
      const ev = [...tx.db.noteEvidence.noteId.filter(n.id)].sort((a, b) => (b.id > a.id ? 1 : -1));
      return {
        id: String(n.id),
        kind: n.kind as MemoryKind,
        category: n.category,
        concept: n.concept,
        conceptTitle: conceptTitle(n.concept),
        text: n.text,
        outcome: (MEMORY_OUTCOMES.includes(n.outcome as MemoryOutcome) ? n.outcome : 'unknown') as MemoryOutcome,
        confidence: n.confidence,
        reinforced: n.reinforced,
        createdMs: ms(n.createdAt),
        updatedMs: ms(n.updatedAt),
        // Seeded (demo seed or simulation profile): only pseudo-session evidence.
        seeded: ev.every(e => e.sessionId >= SEED_SESSION_BASE),
        evidence: ev.slice(0, INSIGHT_EVIDENCE_PER_NOTE).map(e => ({
          sessionId: sessionRef(e.sessionId),
          fromTurn: e.fromTurn,
          toTurn: e.toTurn,
          quote: truncate(e.quote, INSIGHT_QUOTE_MAX),
        })),
      };
    });

  const mastery = [...tx.db.conceptState.learnerId.filter(l.id)]
    .sort((a, b) => desc(a.updatedAt, b.updatedAt))
    .map(c => {
      const category = c.category || tx.db.concept.key.find(c.concept)?.category || pack.taxonomy.find(t => t.concepts.some(k => k.key === c.concept))?.key || '';
      return {
        concept: c.concept,
        title: conceptTitle(c.concept) || c.concept,
        category,
        categoryTitle: categoryTitle(category),
        mastery: c.mastery,
        updatedMs: ms(c.updatedAt),
      };
    });

  // Seeded earlier sessions count like real ones (dated in the past, no session row).
  const sessions = [...tx.db.session.learnerId.filter(l.id)];
  const seeded = [...tx.db.seedSession.learnerId.filter(l.id)];
  const starts = [...sessions.map(s => ms(s.startedAt)), ...seeded.map(s => ms(s.startedAt))];
  const ends = [...sessions.map(s => ms(s.endedAt ?? s.startedAt)), ...seeded.map(s => ms(s.startedAt))];
  const first = starts.length ? Math.min(...starts) : ms(l.createdAt);
  const last = ends.length ? Math.max(...ends) : ms(l.createdAt);

  const summaries = [...tx.db.sessionSummary.learnerId.filter(l.id)]
    .sort((a, b) => desc(a.createdAt, b.createdAt))
    .slice(0, INSIGHT_MAX_SUMMARIES)
    .map(r => {
      const s = tx.db.session.id.find(r.sessionId) ?? tx.db.seedSession.sessionId.find(r.sessionId);
      const topic = s?.concept ?? '';
      return {
        sessionId: sessionRef(r.sessionId),
        summary: r.summary,
        nextFocus: r.nextFocus,
        createdMs: ms(r.createdAt),
        taskText: s?.taskText ?? '',
        topic,
        topicTitle: conceptTitle(topic) || categoryTitle(s?.category ?? ''),
      };
    });

  const persona = l.isSimulated ? tx.db.simProfile.rank.find(l.simRank)?.persona ?? '' : '';

  return {
    ok: true,
    learner: {
      id: String(l.id),
      name: l.name,
      age: l.age,
      grade: l.grade,
      style: l.style,
      isSimulated: l.isSimulated,
      persona,
      sessionCount: sessions.length + seeded.length,
      firstSeenMs: first,
      lastSeenMs: last,
    },
    notes,
    mastery,
    summaries,
    generatedMs: ms(tx.timestamp),
  };
}

export function learnerInsights(ctx: PCtx, args: { learnerId: bigint; teacherId: bigint; key: string }): LearnerInsightsResult {
  return ctx.withTx(tx => readInsights(tx, args));
}
